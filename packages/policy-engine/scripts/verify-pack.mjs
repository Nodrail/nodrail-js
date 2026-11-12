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
const shell = process.platform === "win32";
const run = (command, args, cwd) =>
  execFileSync(command, args, { cwd, encoding: "utf8", stdio: "pipe", shell });

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
export const block: string | null = receiptBlock("x");
export const key: string | null = runKey(".", null, {});
export const read = parseReceipt(block ?? "");
export const compiled = compilePolicies([{ name: "a.yaml", text: "" }]);
export const typed: typeof simulate = simulate;
export const shape: PolicyDocument | null = compiled.ok ? compiled.document : null;
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
  run("node", [typescript, "-p", "tsconfig.json"], folder);

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
    `- rule: Echo
  command: { prefix: echo }
  effect: allow
- rule: Never remove
  command: { prefix: rm }
  effect: deny
`,
  );
  const ran = cli("exec", "gate.yaml", "--", "echo", "hello");
  check(
    ran.status === 0 && ran.stdout.includes("hello"),
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
  check(hook("echo hi").stdout === "", "hook did not stay quiet on allow");
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
  check(listed.stdout.startsWith("repo/work  2 steps"), `runs: ${listed.stdout}`);

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
