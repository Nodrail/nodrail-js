// Proves anyone can install and use the engine with nothing else from Nodrail.
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const engine = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const typescript = resolve(engine, "node_modules/typescript/bin/tsc");

// On Windows npm and pnpm are .cmd files, which only start through a shell.
const run = (command, args, cwd) =>
  execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
    shell: process.platform === "win32" && ["npm", "pnpm"].includes(command),
  });

function check(condition, message) {
  if (condition) return;
  throw new Error(`Engine package check failed: ${message}`);
}

const folder = mkdtempSync(join(tmpdir(), "nodrail-engine-"));
try {
  run("pnpm", ["build"], engine);
  run("pnpm", ["pack", "--pack-destination", folder], engine);
  const [tarball] = readdirSync(folder).filter((name) => name.endsWith(".tgz"));
  check(tarball, "no tarball");

  const listing = run("tar", ["-tzf", tarball], folder);
  for (const forbidden of ["/src/", "/tests/", ".env", "node_modules"])
    check(!listing.includes(forbidden), `tarball contains ${forbidden}`);
  const manifest = JSON.parse(
    run("tar", ["-xzOf", tarball, "package/package.json"], folder),
  );
  const shipped = Object.keys(manifest.dependencies ?? {})
    .sort()
    .join();
  check(
    shipped === "canonicalize,yaml,zod",
    `unexpected dependencies: ${shipped}`,
  );
  check(
    !JSON.stringify(manifest).includes("workspace:"),
    "workspace dependency",
  );
  check(manifest.license === "Apache-2.0", "licence");
  check(listing.includes("package/LICENSE"), "LICENSE missing");

  writeFileSync(
    join(folder, "package.json"),
    JSON.stringify({ name: "consumer", private: true, type: "module" }),
  );
  run(
    "npm",
    ["install", "--no-audit", "--no-fund", "--prefer-offline", `./${tarball}`],
    folder,
  );

  writeFileSync(
    join(folder, "use.ts"),
    `import { simulate, type PolicyDocument } from "@nodrail/policy-engine";
import { compilePolicies } from "@nodrail/policy-engine/yaml";
import { receiptBlock, runKey } from "@nodrail/policy-engine/hook-runs";
import { parseReceipt } from "@nodrail/policy-engine/receipts";
import { runPolicyCommandLine, type Io } from "@nodrail/policy-engine/command-line";
import { compileContracts, readContractReceipt } from "@nodrail/policy-engine/contracts";
import { matchWhere, validateValue } from "@nodrail/policy-engine/contract-values";
import { readFileContent, type FileReading } from "@nodrail/policy-engine/files";
import { cleanRevision, workRevision } from "@nodrail/policy-engine/revision";
import { record, withRunLock, settleMediatedCall, type MediatedSettlement } from "@nodrail/policy-engine/ledger";
import { ACCOUNTABLE_DOCUMENT_VERSION, type NumericBudget, type EvidenceNeed, type LimitState } from "@nodrail/policy-engine";
export const ledger: { record: typeof record; withRunLock: typeof withRunLock; settle: typeof settleMediatedCall } = { record, withRunLock, settle: settleMediatedCall };
export type Accountable = [NumericBudget, EvidenceNeed, LimitState, MediatedSettlement];
export const v4: 4 = ACCOUNTABLE_DOCUMENT_VERSION;
export const fileReading: typeof readFileContent = readFileContent;
export type Reading = FileReading;
export const clean: string | null = cleanRevision("0".repeat(40));
export const work: typeof workRevision = workRevision;
export const contracts = compileContracts({ manifest: {} }).ok;
export const reading: typeof readContractReceipt = readContractReceipt;
export const issues = validateValue({ for: null, properties: {} }, {}).length;
export const matched: boolean = matchWhere([], {});
export const block: string | null = receiptBlock("x");
export const key: string | null = runKey(".", null, {});
export const read = parseReceipt(block ?? "");
export const compiled = compilePolicies([{ name: "a.yaml", text: "" }]);
export const typed: typeof simulate = simulate;
export const shape: PolicyDocument | null = compiled.ok ? compiled.document : null;
export const commandLine: (argv: string[], io?: Io) => Promise<number> =
  runPolicyCommandLine;
`,
  );
  writeFileSync(
    join(folder, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "esnext",
        moduleResolution: "bundler",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        types: [],
      },
      files: ["use.ts"],
    }),
  );
  run(process.execPath, [typescript, "-p", "tsconfig.json"], folder);
  // The subpaths load at runtime too, not only as types.
  const loaded = run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const files = await import("@nodrail/policy-engine/files");
const revision = await import("@nodrail/policy-engine/revision");
const ledger = await import("@nodrail/policy-engine/ledger");
console.log(typeof files.readFileContent, typeof files.checkWrite, revision.cleanRevision("0".repeat(40)), typeof ledger.record, typeof ledger.withRunLock, typeof ledger.settleMediatedCall);`,
    ],
    folder,
  );
  check(
    /^function function sha256:[0-9a-f]{64} function function function\n$/.test(
      loaded,
    ),
    `files, revision and ledger subpaths: ${loaded}`,
  );

  const engineCli = "node_modules/@nodrail/policy-engine/dist/cli.js";
  const rules = "node_modules/@nodrail/policy-engine/examples/rules";
  const cli = (...args) =>
    spawnSync(process.execPath, [engineCli, ...args], {
      cwd: folder,
      encoding: "utf8",
    });
  const validated = cli("validate", rules);
  check(validated.status === 0, `validate failed: ${validated.stderr}`);
  const cases = cli(
    "test",
    rules,
    "--cases",
    "node_modules/@nodrail/policy-engine/examples/cases.yaml",
  );
  check(
    cases.status === 0,
    `example cases failed: ${cases.stdout}${cases.stderr}`,
  );
  const evaluated = cli(
    "eval",
    rules,
    "--tool=github",
    "--operation=repositories.delete",
    "--kind=repository",
    "--resource=acme/app",
  );
  check(
    evaluated.stdout.includes('"outcome": "deny"'),
    `eval: ${evaluated.stdout}`,
  );

  writeFileSync(
    join(folder, "gate.yaml"),
    `- rule: Git version
  command: { prefix: "git version" }
  effect: allow
- rule: Never remove
  command: { prefix: rm }
  effect: deny
`,
  );
  const ran = cli("exec", "gate.yaml", "--", "git", "version");
  check(
    ran.status === 0 && ran.stdout.startsWith("git version "),
    `exec: ${ran.stderr}`,
  );
  writeFileSync(join(folder, "keep.txt"), "x");
  const refused = cli("exec", "gate.yaml", "--", "rm", "keep.txt");
  check(refused.status === 126, `exec should refuse: ${refused.status}`);
  check(existsSync(join(folder, "keep.txt")), "exec ran a denied command");
  const event = (command) =>
    JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command },
    });
  const hook = (command, file = "gate.yaml") =>
    spawnSync(process.execPath, [engineCli, "hook", file], {
      cwd: folder,
      encoding: "utf8",
      input: event(command),
    });
  check(hook("git version").stdout === "", "hook did not stay quiet on allow");
  check(hook("rm -rf x").stdout.includes('"deny"'), "hook did not deny");
  check(
    hook("x", "missing.yaml").status === 2,
    "hook must block without rules",
  );

  // A run through the installed hook, each event its own process as Claude Code runs it.
  const repo = join(folder, "repo");
  mkdirSync(repo);
  spawnSync("git", ["init", "-q", "-b", "work"], { cwd: repo });
  writeFileSync(
    join(repo, "runs.yaml"),
    `- required_engine_version: 3
- rule: Start subagents
  tool: claude-code
  operation: agent
  resource: { kind: agent, match: any }
  effect: allow
- gate: Review first
  tool: claude-code
  operation: agent
  resource: { kind: agent, match: exact, value: github }
  requires: [{ agent: reviewer, verdict: ship, since: [dev] }]
  otherwise: deny
`,
  );
  const installedCli = join(folder, engineCli);
  const send = (payload) =>
    spawnSync(process.execPath, [installedCli, "hook", "runs.yaml"], {
      cwd: repo,
      encoding: "utf8",
      input: JSON.stringify({ session_id: "s", cwd: repo, ...payload }),
    });
  const dispatchGithub = () =>
    send({
      hook_event_name: "PreToolUse",
      tool_name: "Agent",
      tool_input: { subagent_type: "github", prompt: "open the PR" },
    }).stdout;
  check(dispatchGithub().includes('"deny"'), "gate did not hold the dispatch");
  for (const [id, type, verdict] of [
    ["d1", "dev", "done"],
    ["r1", "reviewer", "ship"],
  ]) {
    send({ hook_event_name: "SubagentStart", agent_id: id, agent_type: type });
    send({
      hook_event_name: "SubagentStop",
      agent_id: id,
      agent_type: type,
      last_assistant_message: `ok\n\`\`\`nodrail-receipt\nverdict: ${verdict}\n\`\`\``,
    });
  }
  check(dispatchGithub() === "", "gate did not open after the review");
  const listed = spawnSync(process.execPath, [installedCli, "runs"], {
    cwd: repo,
    encoding: "utf8",
  });
  // No remote, so the run is the repository folder's name and the branch.
  check(
    listed.stdout.startsWith("repo/work  2 steps"),
    `runs: ${listed.stdout}`,
  );

  // Hooks bundle these: no schema library, and reading a receipt runs no git.
  const installed = join(folder, "node_modules/@nodrail/policy-engine/dist");
  const hookRuns = readFileSync(join(installed, "hook-runs.js"), "utf8");
  for (const marker of ['from "zod"', 'from "yaml"'])
    check(!hookRuns.includes(marker), `hook-runs imports ${marker}`);
  const receipts = readFileSync(join(installed, "receipts.js"), "utf8");
  check(!receipts.includes("child_process"), "receipts runs git");

  check(/^\d+\.\d+\.\d+/.test(cli("--version").stdout), "--version");
  check(cli("--help").stdout.includes("Usage"), "--help");
  const pack = cli("init", "repo-work");
  check(pack.status === 0, `init: ${pack.stderr}`);
  writeFileSync(join(folder, "pack.yaml"), pack.stdout);
  check(cli("validate", "pack.yaml").status === 0, "starter pack invalid");

  writeFileSync(join(folder, "bad.yaml"), "- rule: x\n  effect: maybe\n");
  const bad = cli("validate", "bad.yaml");
  check(
    bad.status === 1 && bad.stderr.includes("bad.yaml:1"),
    "bad file accepted",
  );

  console.log("Engine package check passed: installed and used on its own.");
} finally {
  rmSync(folder, { recursive: true, force: true });
}
