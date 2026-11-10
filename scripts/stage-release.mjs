// Stages each package version that npm doesn't have yet. Nothing goes live
// until a maintainer approves it with two-factor authentication:
//
//   npm stage list            what is waiting
//   npm stage approve <id>    release it
//
// Packages are packed by pnpm, which turns workspace links into versions and
// applies publishConfig, then staged with provenance through trusted
// publishing, so no npm token is involved.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Staging needs npm 11.15 or later, so it's pinned rather than taken from Node.
const NPM = "npm@12.2.2";
const PACKAGES = ["packages/policy-engine", "packages/client"];
const dryRun = process.argv.includes("--dry-run");

const npm = (args, options = {}) =>
  execFileSync("npx", ["--yes", NPM, ...args], { encoding: "utf8", ...options });

function isLive(name, version) {
  try {
    return npm(["view", `${name}@${version}`, "version"]).trim() === version;
  } catch {
    return false;
  }
}

function isStaged(name, version) {
  try {
    return npm(["stage", "list", name]).includes(version);
  } catch {
    return false;
  }
}

const folder = mkdtempSync(join(tmpdir(), "nodrail-stage-"));
try {
  for (const directory of PACKAGES) {
    const { name, version } = JSON.parse(
      readFileSync(join(directory, "package.json"), "utf8"),
    );
    if (isLive(name, version)) {
      console.log(`${name}@${version} is already released.`);
      continue;
    }
    if (isStaged(name, version)) {
      console.log(`${name}@${version} is already waiting for approval.`);
      continue;
    }
    const destination = join(folder, name.replace("/", "-"));
    execFileSync("pnpm", ["pack", "--pack-destination", destination], {
      cwd: directory,
      stdio: "inherit",
    });
    const [tarball] = readdirSync(destination);
    npm(
      [
        "stage",
        "publish",
        join(destination, tarball),
        "--access",
        "public",
        ...(dryRun ? ["--dry-run"] : ["--provenance"]),
      ],
      { stdio: "inherit" },
    );
    // Read by changesets/action, which tags the version and writes its release.
    console.log(`New tag: ${name}@${version}`);
    console.log(`${name}@${version} is staged. Approve it with: npm stage list`);
  }
} finally {
  rmSync(folder, { recursive: true, force: true });
}
