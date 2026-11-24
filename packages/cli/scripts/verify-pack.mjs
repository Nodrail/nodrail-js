// Installs the real tarball in an empty folder outside the monorepo and uses it.
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, "..");
const engine = resolve(cli, "../policy-engine");
// The connected hook (`nodrail connect hook`) runs the client's hook in-process.
const client = resolve(cli, "../client");
const { version: expected } = JSON.parse(
  readFileSync(join(cli, "package.json"), "utf8"),
);

const shell = process.platform === "win32";
const run = (command, args, cwd) =>
  execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
    shell: shell && ["npm", "pnpm"].includes(command),
  });
const installedCli = "node_modules/@nodrail/cli/dist/nodrail.mjs";

function fail(message) {
  console.error(`Package check failed: ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

/** The same checks for every tarball: no sources, a licence, no workspace links. */
export function checkTarball(folder, tarball) {
  const listing = run("tar", ["-tzf", tarball], folder);
  for (const forbidden of ["/src/", "/tests/", ".env", "node_modules"])
    if (listing.includes(forbidden)) fail(`${tarball} contains ${forbidden}`);
  const manifest = JSON.parse(
    run("tar", ["-xzOf", tarball, "package/package.json"], folder),
  );
  if (manifest.license !== "Apache-2.0" || !listing.includes("package/LICENSE"))
    fail(`${tarball} is missing its licence`);
  if (JSON.stringify(manifest).includes("workspace:"))
    fail(`${tarball} still has a workspace dependency`);
  if (JSON.stringify(manifest.exports).includes("./src/"))
    fail(`${tarball} exports source files`);
  for (const file of ["README.md", "CHANGELOG.md", "SECURITY.md"])
    if (!listing.includes(`package/${file}`)) fail(`${tarball} has no ${file}`);
}

/** Builds and packs these package folders, then installs them in `folder`. */
export function packAndInstall(folder, packages) {
  for (const directory of packages) {
    run("pnpm", ["build"], directory);
    run("pnpm", ["pack", "--pack-destination", folder], directory);
  }
  const tarballs = readdirSync(folder).filter((name) => name.endsWith(".tgz"));
  if (tarballs.length !== packages.length)
    fail(`expected ${packages.length} tarballs, got ${tarballs}`);
  for (const tarball of tarballs) checkTarball(folder, tarball);
  writeFileSync(
    join(folder, "package.json"),
    JSON.stringify({ name: "consumer", private: true, type: "module" }),
  );
  run(
    "npm",
    [
      "install",
      "--no-audit",
      "--no-fund",
      "--prefer-offline",
      ...tarballs.map((name) => `./${name}`),
    ],
    folder,
  );
  return { run, fail, shell };
}

const fixtureEnv = (folder) => ({
  PATH: process.env.PATH,
  HOME: folder,
  USERPROFILE: folder,
});

function checkCli(folder) {
  const bin = join("node_modules", ".bin", "nodrail");
  const env = fixtureEnv(folder);
  const version = spawnSync(bin, ["--version"], {
    cwd: folder,
    encoding: "utf8",
    env,
    shell,
  });
  if (version.status !== 0 || version.stdout.trim() !== expected)
    fail(`nodrail --version: ${version.stdout}${version.stderr}`);
  const help = spawnSync(bin, ["--help"], {
    cwd: folder,
    encoding: "utf8",
    env,
    shell,
  });
  if (help.status !== 0 || !help.stdout.includes("plan [folder]"))
    fail(`nodrail --help: ${help.stdout}${help.stderr}`);
  const unauthenticated = spawnSync(bin, ["whoami"], {
    cwd: folder,
    encoding: "utf8",
    env,
    shell,
  });
  if (unauthenticated.status !== 1 || !unauthenticated.stderr.includes("login"))
    fail(`nodrail whoami without a token: ${unauthenticated.stderr}`);

  writeFileSync(
    join(folder, "use.mjs"),
    `import { NodrailApi, ApiError } from "@nodrail/cli/api";
import { main } from "@nodrail/cli";
const api = new NodrailApi({ token: "ndp_x", url: "https://x", fetch: async () =>
  new Response(JSON.stringify({ error: { code: "UNAUTHENTICATED", request_id: "r" } }), { status: 401 }) });
try { await api.me(); throw new Error("no error"); } catch (error) {
  if (!(error instanceof ApiError) || error.code !== "UNAUTHENTICATED") throw error;
}
if (typeof main !== "function") throw new Error("main");
`,
  );
  run(process.execPath, ["use.mjs"], folder);
}

/** `nodrail policy` answers exactly what the installed nodrail-policy does. */
function checkPolicy(folder) {
  const rules = "node_modules/@nodrail/policy-engine/examples/rules";
  const both = (args, input = "") =>
    [
      ["node_modules/@nodrail/policy-engine/dist/cli.js"],
      [installedCli, "policy"],
    ].map((entry) => {
      const ran = spawnSync(process.execPath, [...entry, ...args], {
        cwd: folder,
        encoding: "utf8",
        env: fixtureEnv(folder),
        input,
      });
      return JSON.stringify([ran.status, ran.stdout, ran.stderr]);
    });
  const event = (command) =>
    JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command },
    });
  const runs = [
    [["--version"]],
    [["init", "repo-work"]],
    [["validate", rules]],
    [["compile", rules]],
    [["eval", rules, "--command", "git status"]],
    [["check", rules, "--", "git", "push", "--force"]],
    [["hook", rules], event("git status")],
    [["hook", rules], event("git push --force origin main")],
    [["hook", rules, "--unmatched", "ask"], event("curl example.com")],
    [["hook", "missing.yaml"], event("ls")],
  ];
  for (const [args, input] of runs) {
    const [expected, actual] = both(args, input);
    if (expected !== actual)
      fail(`nodrail policy ${args.join(" ")}: ${actual}, not ${expected}`);
  }
  // Two commands that failed alike would also match.
  const [validated] = both(["validate", rules]);
  if (!validated.startsWith('[0,"OK, compiled'))
    fail(`nodrail-policy validate: ${validated}`);
}

/**
 * The catalog ships in the package: a clean project adds the official module
 * offline, gives its repository, locks and exports one rules file.
 */
function checkProject(folder) {
  const project = join(folder, "project");
  mkdirSync(project);
  const bin = join(folder, "node_modules", ".bin", "nodrail");
  const env = fixtureEnv(folder);
  const nodrail = (...args) =>
    spawnSync(bin, args, { cwd: project, encoding: "utf8", env, shell });
  const added = nodrail("add", "@nodrail/pr_policy.yaml");
  if (added.status !== 0 || !added.stdout.includes("configuration required"))
    fail(`nodrail add: ${added.stdout}${added.stderr}`);
  const manifest = join(project, "nodrail.yaml");
  writeFileSync(
    manifest,
    readFileSync(manifest, "utf8").replace(
      'repository: ""',
      "repository: acme/widgets",
    ),
  );
  const locked = nodrail("policy", "lock");
  if (locked.status !== 0) fail(`nodrail policy lock: ${locked.stderr}`);
  const exported = nodrail("policy", "export", "--frozen");
  if (
    exported.status !== 0 ||
    !exported.stdout.includes('value: "acme/widgets"')
  )
    fail(
      `nodrail policy export --frozen: ${exported.stdout}${exported.stderr}`,
    );
}

/**
 * The examples ship in the package: one is copied out, and its own lock
 * exports the policy, from the installed command alone.
 */
function checkExample(folder) {
  const bin = join(folder, "node_modules", ".bin", "nodrail");
  const env = fixtureEnv(folder);
  const copied = spawnSync(bin, ["example", "support-desk", "desk"], {
    cwd: folder,
    encoding: "utf8",
    env,
    shell,
  });
  if (copied.status !== 0)
    fail(`nodrail example: ${copied.stdout}${copied.stderr}`);
  const exported = spawnSync(bin, ["policy", "export", "--frozen"], {
    cwd: join(folder, "desk"),
    encoding: "utf8",
    env,
    shell,
  });
  if (
    exported.status !== 0 ||
    !exported.stdout.includes("Marketing never publishes")
  )
    fail(`the example's policy: ${exported.stdout}${exported.stderr}`);
  checkExampleSetup(folder, bin);
}

/**
 * A host program that only says its version, where a test can't start the
 * real one. Codex's app server is asked which hooks it runs: this one runs
 * none, so the setup is applied and reported inactive, never enforced.
 */
function fakeHosts(folder) {
  const hosts = join(folder, "hosts");
  mkdirSync(hosts);
  const fake = (name, version) =>
    shell
      ? writeFileSync(join(hosts, `${name}.cmd`), `@echo ${version}\r\n`)
      : writeFileSync(join(hosts, name), `#!/bin/sh\necho "${version}"\n`, {
          mode: 0o755,
        });
  fake("claude", "2.1.328 (Claude Code)");
  if (!shell) fake("codex", "codex-cli 0.170.0");
  return hosts;
}

/**
 * The example set up from the installed package, as its README says: plan
 * on each host starts nothing; apply starts the packaged connectors once
 * and writes the setup; a second apply has nothing to change.
 */
function checkExampleSetup(folder, bin) {
  const desk = join(folder, "desk");
  const path = [fakeHosts(folder), dirname(bin), process.env.PATH].join(
    process.platform === "win32" ? ";" : ":",
  );
  const nodrail = (...args) =>
    spawnSync(bin, args, {
      cwd: folder,
      encoding: "utf8",
      shell,
      env: { ...fixtureEnv(folder), PATH: path },
    });
  const runtimes = shell ? ["claude-code"] : ["claude-code", "codex"];
  for (const runtime of runtimes) {
    const plan = nodrail("plan", "./desk", "--runtime", runtime);
    if (
      plan.status !== 0 ||
      !plan.stdout.includes("✓ workspace: matches nodrail.lock.yaml")
    )
      fail(`nodrail plan --runtime ${runtime}: ${plan.stdout}${plan.stderr}`);
  }
  if (
    readdirSync(join(desk, "activity")).some((name) => name.endsWith(".jsonl"))
  )
    fail("plan started a connection");
  const applied = nodrail(
    "apply",
    "./desk",
    "--runtime",
    "claude-code",
    "--yes",
  );
  if (
    applied.status !== 0 ||
    !applied.stdout.includes("✓ connection handbook: offers search") ||
    !applied.stdout.includes("✓ connection outbox: offers publish")
  )
    fail(`nodrail apply: ${applied.stdout}${applied.stderr}`);
  const again = nodrail("apply", "./desk", "--runtime", "claude-code", "--yes");
  if (again.status !== 0 || !again.stdout.includes("Nothing to change."))
    fail(`nodrail apply, again: ${again.stdout}${again.stderr}`);
  const active = nodrail(
    "plan",
    "./desk",
    "--runtime",
    "claude-code",
    "--require-active",
  );
  if (active.status !== 0 || !active.stdout.includes("Policy hook: configured"))
    fail(`nodrail plan --require-active: ${active.stdout}${active.stderr}`);
}

/**
 * The connected hook loads from the installed packages, and without its
 * files blocks a tool call (2) but never a step (0).
 */
function checkConnectHook(folder) {
  const env = fixtureEnv(folder);
  const hook = (event) =>
    spawnSync(process.execPath, [installedCli, "connect", "hook"], {
      cwd: folder,
      env,
      input: JSON.stringify({ hook_event_name: event }),
      encoding: "utf8",
    });
  const call = hook("PreToolUse");
  if (call.status !== 2 || !call.stderr.includes("isn't set up whole"))
    fail(`nodrail connect hook (call): ${call.status} ${call.stderr}`);
  const step = hook("SubagentStart");
  if (step.status !== 0)
    fail(`nodrail connect hook (step): ${step.status} ${step.stderr}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const folder = mkdtempSync(join(tmpdir(), "nodrail-cli-pack-"));
  try {
    packAndInstall(folder, [engine, client, cli]);
    checkConnectHook(folder);
    checkCli(folder);
    checkPolicy(folder);
    checkProject(folder);
    checkExample(folder);
    console.log(
      "Package check passed: installed and used outside the monorepo.",
    );
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}
