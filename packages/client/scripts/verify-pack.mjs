// Installs the real tarballs in an empty folder outside the monorepo and uses them.
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const client = resolve(here, "..");
const core = resolve(client, "../policy-engine");
const typescript = resolve(client, "node_modules/typescript/bin/tsc");

// On Windows npm, pnpm and installed commands are .cmd files, which only start
// through a shell.
const shell = process.platform === "win32";
const run = (command, args, cwd) =>
  execFileSync(command, args, { cwd, encoding: "utf8", stdio: "pipe", shell });

function fail(message) {
  console.error(`Package check failed: ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

const folder = mkdtempSync(join(tmpdir(), "nodrail-pack-"));
try {
  run("pnpm", ["--filter", "@nodrail/client", "build"], client);
  for (const directory of [core, client])
    run("pnpm", ["pack", "--pack-destination", folder], directory);

  const tarballs = readdirSync(folder).filter((name) => name.endsWith(".tgz"));
  if (tarballs.length !== 2) fail(`expected 2 tarballs, got ${tarballs}`);

  for (const tarball of tarballs) {
    const listing = run("tar", ["-tzf", tarball], folder);
    for (const forbidden of ["/src/", "/tests/", ".env", "node_modules"])
      if (listing.includes(forbidden)) fail(`${tarball} contains ${forbidden}`);
    const manifest = JSON.parse(
      run("tar", ["-xzOf", tarball, "package/package.json"], folder),
    );
    if (
      manifest.license !== "Apache-2.0" ||
      !listing.includes("package/LICENSE")
    )
      fail(`${tarball} is missing its licence`);
    if (JSON.stringify(manifest).includes("workspace:"))
      fail(`${tarball} still has a workspace dependency`);
    if (JSON.stringify(manifest.exports).includes("./src/"))
      fail(`${tarball} exports source files`);
  }

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

  writeFileSync(
    join(folder, "use.mjs"),
    `import { NodrailClient, authorize, createNodrail } from "@nodrail/client";
import { codexHooks } from "@nodrail/client/setup";
import { descriptorDigest } from "@nodrail/client/protocol";
import { simulate } from "@nodrail/policy-engine";
import { compilePolicies } from "@nodrail/policy-engine/yaml";
import { readFile } from "node:fs/promises";

const descriptor = { tool: "t", operation: "o", resource: { kind: "k", id: "i" }, params: {} };
if (!descriptorDigest("i", descriptor).startsWith("sha256:")) throw new Error("digest");

const client = new NodrailClient({
  url: "https://x", credential: "c",
  fetch: async () => { throw new Error("down"); },
});
const decision = await authorize(client, descriptor, "key");
if (decision.allowed) throw new Error("allowed while unreachable");

const nodrail = createNodrail({ credential: "c", waitMs: 0, env: {}, fetch: async () => { throw new Error("down"); } });
let ran = false;
const guarded = nodrail.guard({ send: { name: "send", execute: () => { ran = true; } } });
await guarded.send.execute({});
if (ran) throw new Error("a guarded tool ran while unreachable");
if (typeof codexHooks("x").PreToolUse[0].matcher !== "string") throw new Error("setup");

const expected = { "read-allowed": "allow", "write-needs-review": "require_approval", "deny-sensitive": "deny" };
const calls = { "read-allowed": ["issues.read", "acme/support"], "write-needs-review": ["issues.update", "a/b"], "deny-sensitive": ["repositories.delete", "a/b"] };
for (const [name, outcome] of Object.entries(expected)) {
  const name_ = name + ".yaml";
  const compiled = compilePolicies([{ name: name_, text: await readFile("node_modules/@nodrail/client/examples/policies/" + name_, "utf8") }]);
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.issues));
  const [operationKey, resourceId] = calls[name];
  const result = simulate({
    document: compiled.document,
    descriptor: { agentId: "a", installationId: "b", toolKey: "github", operationKey, resourceKind: "repository", resourceId, params: {} },
    now: new Date("2026-11-09T12:00:00.000Z"),
  });
  if (result.outcome !== outcome) throw new Error(name + " gave " + result.outcome);
}
`,
  );
  run("node", ["use.mjs"], folder);

  writeFileSync(
    join(folder, "types.ts"),
    `import { authorize, guard, NodrailClient, type Decision } from "@nodrail/client";
import { simulate } from "@nodrail/policy-engine";
const client = new NodrailClient({ url: "u", credential: "c" });
export const decide = (): Promise<Decision> =>
  authorize(client, { tool: "t", operation: "o", resource: { kind: "k", id: "i" }, params: {} }, "k");
export const typed: typeof simulate = simulate;
// If the types ever resolved to any, this marker would be unused and fail.
// @ts-expect-error a guarded function asks first, so it returns a promise
export const wrong: string = guard((n: number) => String(n), { name: "f" })(1);
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
      files: ["types.ts"],
    }),
  );
  run("node", [typescript, "-p", "tsconfig.json"], folder);
  // The same types under Node's own resolution, which needs file extensions.
  writeFileSync(
    join(folder, "tsconfig.node.json"),
    JSON.stringify({
      extends: "./tsconfig.json",
      compilerOptions: { module: "nodenext", moduleResolution: "nodenext" },
    }),
  );
  run("node", [typescript, "-p", "tsconfig.node.json"], folder);

  const hook = join("node_modules", ".bin", "nodrail-claude-hook");
  const unconfigured = spawnSync(hook, [], {
    cwd: folder,
    input: JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls" },
      tool_use_id: "t",
    }),
    encoding: "utf8",
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
    shell,
  });
  if (
    unconfigured.status !== 0 ||
    !unconfigured.stdout.includes('"permissionDecision":"deny"')
  )
    fail(
      `the installed hook did not block: ${unconfigured.stdout}${unconfigured.stderr}`,
    );

  // Runs on every tool call, so it carries no schema or YAML library.
  const bundled = readFileSync(
    join(folder, "node_modules/@nodrail/client/dist/nodrail-hook.mjs"),
    "utf8",
  );
  if (Buffer.byteLength(bundled) > 80_000)
    fail(`the hook grew to ${Buffer.byteLength(bundled)} bytes`);
  for (const marker of ["ZodError", "YAMLParseError"])
    if (bundled.includes(marker)) fail(`the hook bundles ${marker}`);

  console.log("Package check passed: installed and used outside the monorepo.");
} finally {
  rmSync(folder, { recursive: true, force: true });
}
