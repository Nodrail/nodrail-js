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

const shell = process.platform === "win32";
const run = (command, args, cwd) =>
  execFileSync(command, args, { cwd, encoding: "utf8", stdio: "pipe", shell });

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

function checkCli(folder) {
  const bin = join("node_modules", ".bin", "nodrail");
  const env = { PATH: process.env.PATH, HOME: folder };
  const version = spawnSync(bin, ["--version"], {
    cwd: folder,
    encoding: "utf8",
    env,
    shell,
  });
  if (version.status !== 0 || version.stdout.trim() !== "0.1.0")
    fail(`nodrail --version: ${version.stdout}${version.stderr}`);
  const help = spawnSync(bin, ["--help"], {
    cwd: folder,
    encoding: "utf8",
    env,
    shell,
  });
  if (help.status !== 0 || !help.stdout.includes("nodrail approvals"))
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
  run("node", ["use.mjs"], folder);
}

/** `nodrail policy` answers exactly what the installed nodrail-policy does. */
function checkPolicy(folder) {
  const rules = "node_modules/@nodrail/policy-engine/examples/rules";
  const both = (args, input = "") =>
    ["nodrail-policy", "nodrail policy"].map((name) => {
      const [bin, ...first] = name.split(" ");
      const ran = spawnSync(
        join("node_modules", ".bin", bin),
        [...first, ...args],
        {
          cwd: folder,
          encoding: "utf8",
          env: { PATH: process.env.PATH, HOME: folder },
          input,
          shell,
        },
      );
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
 * offline, gives its repository, locks and exports one APF file.
 */
function checkProject(folder) {
  const project = join(folder, "project");
  mkdirSync(project);
  const bin = join(folder, "node_modules", ".bin", "nodrail");
  const nodrail = (...args) =>
    spawnSync(bin, args, { cwd: project, encoding: "utf8", shell });
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const folder = mkdtempSync(join(tmpdir(), "nodrail-cli-pack-"));
  try {
    packAndInstall(folder, [engine, cli]);
    checkCli(folder);
    checkPolicy(folder);
    checkProject(folder);
    console.log(
      "Package check passed: installed and used outside the monorepo.",
    );
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}
