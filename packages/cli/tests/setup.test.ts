import {
  chmodSync,
  existsSync,
  rmSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { delimiter, join } from "node:path";
import { describe, expect, test } from "vitest";
import { stageJournal, replayJournal } from "../src/project/journal.ts";
import { applySetup } from "../src/setup/apply.ts";
import { codexHookCommand } from "../src/setup/codex.ts";
import { planSetup } from "../src/setup/plan.ts";
import { heldByAnother, killed } from "./support/writers.ts";
import { projectFolder } from "./support/project-folder.ts";

const api = "apiVersion: apf.nodrail.com/v1alpha1";
const windows = process.platform === "win32";

const RESOURCES = {
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
function tools(version = "2.1.327") {
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

function project(
  files: Record<string, string> = RESOURCES,
  bin: string | null = tools(),
) {
  const env = {
    PATH: bin ?? "",
    ...(windows
      ? { PATHEXT: ".CMD", SystemRoot: process.env.SystemRoot! }
      : {}),
  };
  const folder = projectFolder(files, env);
  const plan = () => planSetup({ root: folder.cwd, home: folder.home, env });
  return { ...folder, env, plan };
}

async function locked(files?: Record<string, string>, bin?: string | null) {
  const p = project(files, bin);
  const lock = await p.run("policy", "lock");
  expect(lock.err).toBe("");
  return p;
}

/** Every file under the folder with its hash: what "changed nothing" means. */
function snapshot(root: string) {
  const files: Record<string, string> = {};
  const walk = (folder: string) => {
    for (const entry of readdirSync(join(root, folder))) {
      const path = folder ? `${folder}/${entry}` : entry;
      if (statSync(join(root, path)).isDirectory()) walk(path);
      else
        files[path] = createHash("sha256")
          .update(readFileSync(join(root, path)))
          .digest("hex");
    }
  };
  walk("");
  return files;
}

const action = (p: ReturnType<typeof project>, path: string) =>
  p.plan().steps.find((step) => step.path === path)?.action;

const owned = (
  p: ReturnType<typeof project>,
  files: Record<string, string>,
  agent?: string,
) =>
  p.write(
    ".nodrail/setup-state.json",
    JSON.stringify({
      state: 1,
      runtime: "claude-code",
      files: Object.fromEntries(
        Object.entries(files).map(([path, text]) => [
          path,
          createHash("sha256").update(text).digest("hex"),
        ]),
      ),
      settings: agent ? { agent } : {},
    }),
  );

describe("nodrail plan", () => {
  test("lists what apply would write, and changes nothing", async () => {
    const p = await locked();
    const before = snapshot(p.cwd);
    const { code, out, err } = await p.run("plan");
    expect(err).toBe("");
    expect(code).toBe(0);
    expect(snapshot(p.cwd)).toEqual(before);
    expect(out).toContain(
      "Plan for Claude Code: team release, starting as lead",
    );
    for (const line of [
      "✓ claude: 2.1.327",
      "✓ policy: matches nodrail.lock.yaml",
      "+ .claude/agents/lead.md",
      "+ .claude/agents/publisher.md",
      "+ .claude/skills/release-notes/SKILL.md",
      "+ .claude/skills/release-notes/template.md",
      "+ .nodrail/effective.apf.yaml",
      "+ .nodrail/protected.txt",
      "+ .claude/settings.json",
      "Agent loner isn't on team release; it isn't set up.",
      "7 changes. Nothing was changed; `nodrail apply` makes them.",
    ])
      expect(out).toContain(line);
  });

  test("writes the agents, skills, policy and settings Claude Code reads", async () => {
    const p = await locked();
    const plan = p.plan();
    const file = (path: string) =>
      plan.files.find((each) => each.path === path)?.content.toString("utf8");
    expect(file(".claude/agents/lead.md")).toBe(`---
# Written by nodrail apply from resources/agents.yaml. Change that file, not this one.
name: lead
description: Plans the release and hands work on.
skills:
  - release-notes
---
You lead the release.
`);
    expect(file(".claude/agents/publisher.md")).toContain(
      "description: The publisher agent of team release.",
    );
    expect(file(".claude/skills/release-notes/template.md")).toBe(
      "## Changes\n",
    );
    // Everything the setup is made from, kept from agents by the hook.
    expect(file(".nodrail/protected.txt"))
      .toBe(`# Written by nodrail apply. The setup's files, from the project folder:
# the policy hook keeps agents from changing them.
.claude
.nodrail
nodrail.lock.yaml
nodrail.yaml
policies/base.yaml
resources/agents.yaml
resources/lead.md
resources/team.yaml
skills/release-notes
`);
    // The policy is the frozen export, team rules included.
    const effective = file(".nodrail/effective.apf.yaml")!;
    expect(effective).toContain("lead may start publisher");
    expect((await p.run("policy", "export", "--frozen")).out).toBe(
      effective.replace(/\n$/, ""),
    );
    expect(plan.settings).toEqual({
      agent: "lead",
      hooks: {
        PreToolUse: [
          {
            matcher: "*",
            hooks: [
              {
                type: "command",
                command:
                  'nodrail policy hook "$CLAUDE_PROJECT_DIR/.nodrail/effective.apf.yaml" --protect-list "$CLAUDE_PROJECT_DIR/.nodrail/protected.txt" --agent lead',
                onFailure: "block",
              },
            ],
          },
        ],
      },
    });
  });

  test("keeps everyone else's settings and hooks, and replaces only its own", async () => {
    const p = await locked();
    const theirs = {
      type: "command",
      command: "./lint.sh",
    };
    p.write(
      ".claude/settings.json",
      JSON.stringify({
        model: "opus",
        hooks: {
          PreToolUse: [
            {
              matcher: "*",
              hooks: [
                theirs,
                {
                  type: "command",
                  command:
                    'nodrail policy hook "$CLAUDE_PROJECT_DIR/.nodrail/old.yaml" --agent lead',
                },
              ],
            },
          ],
          Stop: [{ hooks: [theirs] }],
        },
      }),
    );
    const plan = p.plan();
    expect(action(p, ".claude/settings.json")).toBe("update");
    expect(plan.settings).toMatchObject({
      model: "opus",
      agent: "lead",
      hooks: {
        Stop: [{ hooks: [theirs] }],
        PreToolUse: [
          { matcher: "*", hooks: [theirs] },
          { matcher: "*", hooks: [{ onFailure: "block" }] },
        ],
      },
    });
  });

  test("never takes over what someone else set", async () => {
    const p = await locked();
    p.write(".claude/settings.json", JSON.stringify({ agent: "someone" }));
    p.write(".claude/agents/lead.md", "mine\n");
    const { code, out, err } = await p.run("plan");
    expect(code).toBe(1);
    expect(out).toMatch(
      /! \.claude\/agents\/lead\.md +agent lead; already there, not written by nodrail/,
    );
    expect(out).toContain('agent is set to "someone", not by nodrail');
    expect(out).toContain("Nothing was changed. Fix what is marked ! first.");
    expect(err).toContain("The plan can't be applied yet");
  });

  test("updates what it wrote, but not once a person has edited it", async () => {
    const p = await locked();
    p.write(".claude/agents/publisher.md", "old\n");
    p.write(".claude/agents/lead.md", "edited\n");
    p.write(".claude/agents/gone.md", "gone\n");
    p.write(".claude/agents/gone-edited.md", "edited\n");
    owned(p, {
      ".claude/agents/publisher.md": "old\n",
      ".claude/agents/lead.md": "as written\n",
      ".claude/agents/gone.md": "gone\n",
      ".claude/agents/gone-edited.md": "as written\n",
    });
    expect(action(p, ".claude/agents/publisher.md")).toBe("update");
    expect(action(p, ".claude/agents/lead.md")).toBe("conflict");
    expect(action(p, ".claude/agents/gone.md")).toBe("remove");
    expect(action(p, ".claude/agents/gone-edited.md")).toBe("conflict");
  });

  test("an unchanged setup has nothing to do", async () => {
    const p = await locked();
    const first = p.plan();
    for (const file of first.files)
      p.write(file.path, file.content.toString("utf8"));
    p.write(".claude/settings.json", JSON.stringify(first.settings));
    const { code, out } = await p.run("plan");
    expect(code).toBe(0);
    expect(out).toContain("Nothing to change. Nothing was changed.");
  });

  test.skipIf(windows)("never writes through a link", async () => {
    const p = await locked();
    const outside = mkdtempSync(join(tmpdir(), "nodrail-outside-"));
    symlinkSync(outside, join(p.cwd, ".claude"));
    expect(action(p, ".claude/agents/lead.md")).toBe("conflict");
  });

  test("a policy that isn't locked blocks apply and isn't planned", async () => {
    const p = project();
    const { code, out } = await p.run("plan");
    expect(code).toBe(1);
    expect(out).toContain("! policy: No nodrail.lock.yaml here.");
    expect(out).not.toContain(".nodrail/effective.apf.yaml");
    expect(out).toContain("+ .claude/agents/lead.md");
  });

  test.each([
    ["missing", null, "! claude: not on PATH; install Claude Code"],
    ["too old", "2.1.200", "! claude: 2.1.200; needs 2.1.295 or later"],
  ])("Claude Code %s blocks apply", async (_name, version, line) => {
    const p = await locked(RESOURCES, version === null ? null : tools(version));
    const { code, out } = await p.run("plan");
    expect(code).toBe(1);
    expect(out).toContain(line);
    if (version === null)
      expect(out).toContain("! nodrail: not on PATH; the policy hook runs it");
  });

  test.skipIf(windows)("a link inside a skill is refused", async () => {
    const p = await locked();
    symlinkSync("/etc/hosts", join(p.cwd, "skills/release-notes/hosts"));
    expect(p.plan().problems).toEqual([
      "skills/release-notes/hosts is a link; skills are copied without links.",
    ]);
  });

  test("--json says the same, for scripts", async () => {
    const p = await locked();
    const { code, out } = await p.run("plan", "--json");
    expect(code).toBe(0);
    const value = JSON.parse(out) as Record<string, unknown>;
    expect(value).toMatchObject({
      runtime: "claude-code",
      team: "release",
      entry: "lead",
      ready: true,
    });
    expect(value.steps).toContainEqual({
      path: ".claude/agents/lead.md",
      action: "create",
      why: "agent lead",
    });
  });

  test("without a runtime or a team there's nothing to plan", async () => {
    const p = project({
      "nodrail.yaml": "kind: nodrail.project/v1\nimports: [./a.yaml]\n",
      "a.yaml": "[]\n",
    });
    const result = await p.run("plan");
    expect(result.code).toBe(1);
    expect(result.err).toContain("doesn't say which host to set up");
  });
});

// The claude a shell would run is the one judged: the first on PATH.
test("PATH is searched in order", async () => {
  const [old, current] = [tools("2.1.200"), tools("2.1.400")];
  const p = await locked(RESOURCES, `${old}${delimiter}${current}`);
  expect(p.plan().checks).toContainEqual({
    name: "claude",
    ok: false,
    detail: "2.1.200; needs 2.1.295 or later",
  });
});

describe("nodrail apply", () => {
  /** The project's files apart from the ones apply writes. */
  const applied = (p: ReturnType<typeof project>) =>
    p.plan().steps.filter((step) => step.action !== "keep");

  test("putting the resources back and applying restores the earlier setup", async () => {
    const p = await locked();
    await p.run("apply", "--yes");
    const first = snapshot(p.cwd);
    // A second revision: a skill, an agent and a member change.
    p.write(
      "skills/release-notes/SKILL.md",
      "---\nname: release-notes\n---\nNew steps.\n",
    );
    p.write("resources/lead.md", "You lead, differently.\n");
    p.write(
      "resources/team.yaml",
      RESOURCES["resources/team.yaml"]
        .replace("[lead, publisher]", "[lead]")
        .replace("[{ from: lead, to: publisher }]", "[]"),
    );
    await p.run("policy", "lock");
    expect((await p.run("apply", "--yes")).code).toBe(0);
    expect(snapshot(p.cwd)).not.toEqual(first);
    // Back to the first revision, as `git checkout` of the resources would.
    for (const path of [
      "skills/release-notes/SKILL.md",
      "resources/lead.md",
      "resources/team.yaml",
    ])
      p.write(path, RESOURCES[path as keyof typeof RESOURCES]);
    await p.run("policy", "lock");
    expect((await p.run("apply", "--yes")).code).toBe(0);
    expect(snapshot(p.cwd)).toEqual(first);
  });

  test("a file of yours that matches is never taken, so never removed", async () => {
    const p = await locked();
    // The person's own copy, byte for byte what nodrail would write.
    const theirs = p
      .plan()
      .files.find((file) => file.path === ".claude/agents/publisher.md")!
      .content.toString("utf8");
    p.write(".claude/agents/publisher.md", theirs);
    expect(action(p, ".claude/agents/publisher.md")).toBe("keep");
    expect((await p.run("apply", "--yes")).code).toBe(0);
    const state = JSON.parse(p.read(".nodrail/setup-state.json")) as {
      files: Record<string, string>;
    };
    expect(state.files[".claude/agents/publisher.md"]).toBeUndefined();
    // The publisher leaves the team: nodrail removes nothing of the person's.
    p.write(
      "resources/team.yaml",
      RESOURCES["resources/team.yaml"]
        .replace("[lead, publisher]", "[lead]")
        .replace("[{ from: lead, to: publisher }]", "[]"),
    );
    await p.run("policy", "lock");
    expect(action(p, ".claude/agents/publisher.md")).toBeUndefined();
    expect((await p.run("apply", "--yes")).code).toBe(0);
    expect(p.read(".claude/agents/publisher.md")).toBe(theirs);
  });

  test("settings with every hook off, or behind a link, are not touched", async () => {
    const p = await locked();
    p.write(".claude/settings.json", JSON.stringify({ disableAllHooks: true }));
    expect(p.plan().steps).toContainEqual({
      path: ".claude/settings.json",
      action: "conflict",
      why: "start as lead; the policy hook; disableAllHooks is on, so no hook would run",
    });
    if (windows) return;
    const dotfiles = mkdtempSync(join(tmpdir(), "nodrail-dotfiles-"));
    writeFileSync(join(dotfiles, "settings.json"), "{}");
    rmSync(join(p.cwd, ".claude/settings.json"));
    symlinkSync(
      join(dotfiles, "settings.json"),
      join(p.cwd, ".claude/settings.json"),
    );
    expect(action(p, ".claude/settings.json")).toBe("conflict");
  });

  test("a policy-only change applies to open sessions, with no restart", async () => {
    const p = await locked();
    await p.run("apply", "--yes");
    p.write(
      "policies/base.yaml",
      RESOURCES["policies/base.yaml"].replace(
        "Read anything",
        "Read every file",
      ),
    );
    expect((await p.run("policy", "lock")).code).toBe(0);
    const { code, out } = await p.run("apply", "--yes");
    expect(code).toBe(0);
    expect(out).toContain("Applied 1 change.");
    expect(out).toContain("from their next tool call");
    expect(out).not.toContain("start a new one");
  });

  test("writes exactly what plan showed, then has nothing to do", async () => {
    const p = await locked();
    const plan = p.plan();
    const first = await p.run("apply", "--yes");
    expect(first.err).toBe("");
    expect(first.code).toBe(0);
    expect(first.out).toContain("Applied 7 changes.");
    expect(first.out).toContain(
      "Run `claude` in this folder: it starts as lead",
    );
    for (const file of plan.files)
      expect(readFileSync(join(p.cwd, file.path))).toEqual(file.content);
    expect(JSON.parse(p.read(".claude/settings.json"))).toEqual(plan.settings);
    expect(JSON.parse(p.read(".nodrail/setup-state.json"))).toMatchObject({
      state: 1,
      runtime: "claude-code",
      settings: { agent: "lead" },
    });
    expect(applied(p)).toEqual([]);
    const before = snapshot(p.cwd);
    const again = await p.run("apply", "--yes");
    expect(again.out).toContain("Nothing to change.");
    expect(snapshot(p.cwd)).toEqual(before);
  });

  test("asks first, and a no changes nothing", async () => {
    const p = await locked();
    const before = snapshot(p.cwd);
    const terminal = await import("./support/fake-io.ts").then(({ fakeIo }) =>
      fakeIo({
        cwd: p.cwd,
        home: p.home,
        env: p.env,
        interactive: true,
        answers: ["n"],
      }),
    );
    expect(await terminal.run("apply")).toBe(0);
    expect(terminal.stdout()).toContain("Nothing was changed.");
    expect(snapshot(p.cwd)).toEqual(before);
  });

  test("without a terminal or --yes, it won't change anything", async () => {
    const p = await locked();
    const before = snapshot(p.cwd);
    const result = await p.run("apply");
    expect(result.code).toBe(2);
    expect(result.err).toContain("add --yes once you have read `nodrail plan`");
    expect((await p.run("apply", "--json")).err).toContain("needs --yes");
    expect(snapshot(p.cwd)).toEqual(before);
  });

  test("anything plan marks ! stops it before any write", async () => {
    const p = await locked();
    p.write(".claude/agents/lead.md", "mine\n");
    const before = snapshot(p.cwd);
    const result = await p.run("apply", "--yes");
    expect(result.code).toBe(1);
    expect(result.err).toContain(
      "Nothing was changed. Fix what is marked ! first",
    );
    expect(snapshot(p.cwd)).toEqual(before);
  });

  test("a changed resource changes only its own file; a removed member goes", async () => {
    const p = await locked();
    await p.run("apply", "--yes");
    p.write(
      "resources/team.yaml",
      RESOURCES["resources/team.yaml"]
        .replace("[lead, publisher]", "[lead]")
        .replace("[{ from: lead, to: publisher }]", "[]"),
    );
    p.write("resources/lead.md", "You lead the release, alone.\n");
    expect((await p.run("policy", "lock")).code).toBe(0);
    expect(applied(p).map((step) => [step.path, step.action])).toEqual([
      [".claude/agents/lead.md", "update"],
      [".nodrail/effective.apf.yaml", "update"],
      [".claude/agents/publisher.md", "remove"],
    ]);
    const second = await p.run("apply", "--yes");
    expect(second.code).toBe(0);
    // Agent files changed: an open session has to start again to see them.
    expect(second.out).toContain(
      "A Claude Code session already open here keeps the agents, skills and settings it started with: start a new one to use these.",
    );
    expect(second.out).toContain(
      "The policy applies to open sessions too, from their next tool call.",
    );
    expect(p.read(".claude/agents/lead.md")).toContain("alone.");
    expect(existsSync(join(p.cwd, ".claude/agents/publisher.md"))).toBe(false);
    expect(applied(p)).toEqual([]);
  });

  test("another nodrail at work holds it off", async () => {
    const p = await locked();
    const other = heldByAnother(p);
    const result = await p.run("apply", "--yes");
    expect(result.code).toBe(1);
    expect(result.err).toContain(`Another nodrail (process ${other})`);
    expect(existsSync(join(p.cwd, ".claude"))).toBe(false);
  });

  test("a project that changed after the plan was shown is refused", async () => {
    const p = await locked();
    const reviewed = p.plan();
    p.write("skills/release-notes/template.md", "## Changed\n");
    expect(() =>
      applySetup({ root: p.cwd, home: p.home, env: p.env }, reviewed),
    ).toThrow("The project changed after the plan was shown");
    expect(existsSync(join(p.cwd, ".claude"))).toBe(false);
  });

  test("a file changed between staging and writing is left alone and named", () => {
    const root = mkdtempSync(join(tmpdir(), "nodrail-journal-"));
    const folder = mkdtempSync(join(tmpdir(), "nodrail-stage-"));
    writeFileSync(join(root, "a.txt"), "old");
    const hash = (text: string) =>
      createHash("sha256").update(text).digest("hex");
    stageJournal(
      folder,
      [
        { path: "a.txt", before: hash("old"), after: hash("new") },
        { path: "dir/b.txt", before: null, after: hash("b") },
      ],
      new Map([
        ["a.txt", Buffer.from("new")],
        ["dir/b.txt", Buffer.from("b")],
      ]),
    );
    writeFileSync(join(root, "a.txt"), "someone else's");
    expect(replayJournal(root, folder)).toEqual(["a.txt"]);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("someone else's");
    expect(readFileSync(join(root, "dir/b.txt"), "utf8")).toBe("b");
    // Replaying again changes nothing more: it is safe at any point.
    expect(replayJournal(root, folder)).toEqual(["a.txt"]);
  });

  test.skipIf(windows)(
    "never writes through a link planted after the plan",
    () => {
      const root = mkdtempSync(join(tmpdir(), "nodrail-journal-"));
      const folder = mkdtempSync(join(tmpdir(), "nodrail-stage-"));
      const outside = mkdtempSync(join(tmpdir(), "nodrail-outside-"));
      const hash = createHash("sha256").update("x").digest("hex");
      stageJournal(
        folder,
        [{ path: ".claude/x.md", before: null, after: hash }],
        new Map([[".claude/x.md", Buffer.from("x")]]),
      );
      symlinkSync(outside, join(root, ".claude"));
      expect(() => replayJournal(root, folder)).toThrow("goes through a link");
      expect(readdirSync(outside)).toEqual([]);
    },
  );

  test.each(["rename:2", "rename:5"])(
    "killed partway (%s), the next nodrail finishes the apply",
    async (step) => {
      const p = await locked();
      const plan = p.plan();
      expect(killed({ ...p, env: p.env }, step, "apply", "--yes")).toBe(9);
      const stuck = await p.run("plan");
      expect(stuck.out).toContain("interrupted");
      // Any writer settles it first; apply then finds nothing left to do.
      const settle = await p.run("apply", "--yes");
      expect(settle.err).toBe("");
      expect(settle.out).toContain("Nothing to change.");
      for (const file of plan.files)
        expect(readFileSync(join(p.cwd, file.path))).toEqual(file.content);
      expect(existsSync(join(p.cwd, ".nodrail/setup-state.json"))).toBe(true);
    },
  );

  test("killed before the journal was ready, nothing was written", async () => {
    const p = await locked();
    const before = snapshot(p.cwd);
    expect(killed({ ...p, env: p.env }, "ready", "apply", "--yes")).toBe(9);
    expect((await p.run("policy", "lock")).out).toContain("up to date");
    expect(snapshot(p.cwd)).toEqual(before);
  });
});

// A `codex` on PATH that answers --version and, as its app server, lists the
// hooks in `hooks.json` next to it, the way Codex 0.169 does.
function codexTools(version = "0.169.0") {
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

const CODEX = {
  ...RESOURCES,
  "nodrail.yaml": RESOURCES["nodrail.yaml"].replace("claude-code", "codex"),
};

describe.skipIf(windows)("Codex", () => {
  async function codexProject() {
    const bin = codexTools();
    const p = await locked(CODEX, bin);
    /** What Codex lists: nodrail's hook with this trust, or no hook at all. */
    const trust = (status: string | null) =>
      writeFileSync(
        join(bin, "hooks.json"),
        JSON.stringify(
          status === null
            ? []
            : [
                {
                  source: "project",
                  eventName: "preToolUse",
                  command: codexHookCommand(p.cwd, "lead"),
                  trustStatus: status,
                },
              ],
        ),
      );
    return { ...p, bin, trust };
  }

  test("plans the entry agent, the other members, skills and the hook", async () => {
    const p = await codexProject();
    const plan = p.plan();
    expect(plan.steps.map((step) => [step.path, step.action])).toEqual([
      [".agents/skills/release-notes/SKILL.md", "create"],
      [".agents/skills/release-notes/template.md", "create"],
      [".codex/agents/publisher.toml", "create"],
      [".codex/config.toml", "create"],
      [".codex/hooks.json", "create"],
      [".nodrail/effective.apf.yaml", "create"],
      [".nodrail/protected.txt", "create"],
    ]);
    expect(plan.checks).toContainEqual({
      name: "codex",
      ok: true,
      detail: "0.169.0",
    });
    const file = (path: string) =>
      plan.files.find((each) => each.path === path)!.content.toString("utf8");
    expect(file(".codex/config.toml"))
      .toBe(`# Written by nodrail apply from resources/agents.yaml. Change that file, not this one.
developer_instructions = "You lead the release.\\n"

[agents]
enabled = true
`);
    expect(file(".codex/agents/publisher.toml")).toContain(
      'description = "The publisher agent of team release."',
    );
    const hooks = JSON.parse(file(".codex/hooks.json")) as {
      hooks: { PreToolUse: { hooks: { command: string }[] }[] };
    };
    expect(hooks.hooks.PreToolUse[0]!.hooks[0]!.command).toBe(
      codexHookCommand(p.cwd, "lead"),
    );
    // Before apply, Codex lists no hook of nodrail's: it says what comes next.
    const { code, out } = await p.run("plan");
    expect(code).toBe(0);
    expect(out).toContain(
      "Codex won't run the policy yet: Codex doesn't load this folder's hooks until you trust the folder",
    );
  });

  test("the hook denies when nodrail can't run, and answers for it when it can", () => {
    const command = codexHookCommand("/tmp", "lead");
    const sh = (path: string) =>
      spawnSync("/bin/sh", ["-c", command], {
        input: "{}",
        encoding: "utf8",
        env: { PATH: path },
      }).stdout;
    expect(JSON.parse(sh(""))).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    const bin = mkdtempSync(join(tmpdir(), "nodrail-bin-"));
    writeFileSync(join(bin, "nodrail"), "#!/bin/sh\nprintf allowed\n");
    chmodSync(join(bin, "nodrail"), 0o755);
    expect(sh(bin)).toBe("allowed");
  });

  test.each([
    [null, "trust the folder"],
    [
      "untrusted",
      "nodrail's hook is untrusted. Open codex here, run /hooks and trust it",
    ],
    [
      "modified",
      "nodrail's hook is modified. Open codex here, run /hooks and trust it",
    ],
  ])(
    "apply writes the files, but isn't done while Codex's trust is %s",
    async (status, detail) => {
      const p = await codexProject();
      p.trust(status);
      const result = await p.run("apply", "--yes");
      expect(result.code).toBe(1);
      expect(result.out).toContain("Applied 7 changes.");
      expect(result.err).toContain(`Codex won't run the policy yet:`);
      expect(result.err).toContain(detail);
      expect(existsSync(join(p.cwd, ".codex/hooks.json"))).toBe(true);
    },
  );

  test("once Codex trusts the folder and the hook, apply is done", async () => {
    const p = await codexProject();
    p.trust("trusted");
    const result = await p.run("apply", "--yes");
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    expect(result.out).toContain(
      "Run `codex` in this folder: it starts as lead",
    );
    expect((await p.run("plan")).out).not.toContain("won't run the policy");
    expect(JSON.parse(p.read(".nodrail/setup-state.json"))).toMatchObject({
      runtime: "codex",
      settings: {},
    });
  });

  test("an older Codex blocks apply", async () => {
    const p = await locked(CODEX, codexTools("0.150.0"));
    const { code, out } = await p.run("plan");
    expect(code).toBe(1);
    expect(out).toContain("! codex: 0.150.0; needs 0.169.0 or later");
  });
});
