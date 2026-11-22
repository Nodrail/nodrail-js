// A project folder set up for `nodrail plan` and `apply`: a team's
// resources, and fake `claude`, `nodrail` and `codex` on PATH.
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { spoolFolder } from "@nodrail/policy-engine/command-line";
import { compilePolicies } from "@nodrail/policy-engine/yaml";
import { TELEMETRY_FILE } from "../../src/setup/connections.ts";
import { planSetup } from "../../src/setup/plan.ts";
import { projectFolder } from "./project-folder.ts";

const api = "apiVersion: apf.nodrail.com/v1alpha1";
export const windows = process.platform === "win32";

export const RESOURCES = {
  "resources/agents.yaml": [
    `${api}
kind: Agent
metadata: { name: lead }
spec:
  description: Plans the release and hands work on.
  instructions: ./lead.md
  skills: [../skills/release-notes]`,
    `${api}\nkind: Agent\nmetadata: { name: publisher }`,
    `${api}\nkind: Agent\nmetadata: { name: loner }`,
  ].join("\n---\n"),
  "resources/lead.md": "You lead the release.\n",
  "skills/release-notes/SKILL.md":
    "---\nname: release-notes\ndescription: Write release notes.\n---\nSteps.\n",
  "skills/release-notes/template.md": "## Changes\n",
  "resources/team.yaml": `${api}
kind: Team
metadata: { name: release }
spec:
  entry: lead
  members: [lead, publisher]
  handoffs: [{ from: lead, to: publisher }]
`,
  "policies/base.yaml": `- rule: Read anything
  tool: files
  operation: file.read
  resource: { kind: file, match: any }
  effect: allow
`,
  "nodrail.yaml": `kind: nodrail.project/v1
runtime: claude-code
resources: ./resources
imports:
  - ./policies/base.yaml
`,
};

/** A folder with a fake `claude` and `nodrail`, as PATH would find them. */
export function tools(version = "2.1.327") {
  const bin = mkdtempSync(join(tmpdir(), "nodrail-bin-"));
  for (const [name, text] of [
    ["claude", `${version} (Claude Code)`],
    ["nodrail", "0.1.0"],
  ] as const) {
    const file = join(bin, windows ? `${name}.cmd` : name);
    writeFileSync(
      file,
      windows ? `@echo ${text}\r\n` : `#!/bin/sh\necho "${text}"\n`,
    );
    chmodSync(file, 0o755);
  }
  return bin;
}

export function project(
  files: Record<string, string> = RESOURCES,
  bin: string | null = tools(),
) {
  const env: Record<string, string> = {
    PATH: bin ?? "",
    ...(windows
      ? { PATHEXT: ".CMD", SystemRoot: process.env.SystemRoot! }
      : {}),
  };
  const folder = projectFolder(files, env);
  const plan = () => planSetup({ root: folder.cwd, home: folder.home, env });
  return { ...folder, env, plan };
}

export async function locked(
  files?: Record<string, string>,
  bin?: string | null,
) {
  const p = project(files, bin);
  const lock = await p.run("policy", "lock");
  expect(lock.err).toBe("");
  return p;
}

// A `codex` on PATH that answers --version and, as its app server, lists the
// hooks in `hooks.json` next to it, the way Codex 0.169 does.
export function codexTools(version = "0.169.0") {
  const bin = tools();
  writeFileSync(
    join(bin, "codex"),
    `#!${process.execPath}
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
if (process.argv[2] === "--version") { console.log("codex-cli ${version}"); process.exit(0); }
let buffer = "";
process.stdin.on("data", (data) => {
  buffer += data;
  let at;
  while ((at = buffer.indexOf("\\n")) >= 0) {
    const message = JSON.parse(buffer.slice(0, at));
    buffer = buffer.slice(at + 1);
    if (message.id === 1) console.log(JSON.stringify({ id: 1, result: {} }));
    if (message.id === 2) {
      let hooks = [];
      try { hooks = JSON.parse(readFileSync(join(__dirname, "hooks.json"), "utf8")); } catch {}
      console.log(JSON.stringify({ id: 2, result: { data: [{ cwd: message.params.cwds[0], hooks }] } }));
    }
  }
});
`,
  );
  chmodSync(join(bin, "codex"), 0o755);
  return bin;
}

/** Every file under the folder, by its path there, with its bytes. */
export function filesUnder(root: string) {
  const files: Record<string, Buffer> = {};
  const walk = (folder: string) => {
    for (const entry of readdirSync(join(root, folder))) {
      const path = folder ? `${folder}/${entry}` : entry;
      if (statSync(join(root, path)).isDirectory()) walk(path);
      else files[path] = readFileSync(join(root, path));
    }
  };
  walk("");
  return files;
}

/** What the telemetry sender last recorded for the project, as it would. */
export function recordSenderStatus(
  p: { cwd: string; home: string },
  status: object,
) {
  const folder = spoolFolder(p.home, join(p.cwd, TELEMETRY_FILE));
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "status.json"), JSON.stringify(status));
}

/** `tools()`, with a fake Copilot CLI at this version. */
export function copilotTools(version = "1.0.114") {
  const bin = tools();
  const file = join(bin, "copilot");
  writeFileSync(file, `#!/bin/sh\necho "GitHub Copilot CLI ${version}."\n`);
  chmodSync(file, 0o755);
  return bin;
}

/** What `nodrail plan` would set up for the project on this host. */
export const planFor = (p: ReturnType<typeof project>, runtime: string) =>
  planSetup({ root: p.cwd, home: p.home, env: p.env, runtime });

/** One planned file's text. */
export const fileOf = (plan: ReturnType<typeof planSetup>, path: string) =>
  plan.files.find((file) => file.path === path)!.content.toString();

/** The lead agent's generated file on Claude Code and on Copilot. */
export const leadFiles = (p: ReturnType<typeof project>) => ({
  claude: fileOf(planFor(p, "claude-code"), ".claude/agents/lead.md"),
  copilot: fileOf(planFor(p, "copilot"), ".github/agents/lead.agent.md"),
});

/** The document the hook compiles an effective policy into; it must compile. */
export function hookDocument(text: string): Record<string, any> {
  const compiled = compilePolicies([{ name: "effective.apf.yaml", text }]);
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.issues));
  return compiled.document as Record<string, any>;
}
