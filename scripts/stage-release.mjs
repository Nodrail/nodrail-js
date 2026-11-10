// Stages each package version that npm doesn't have yet. Nothing goes live
// until a maintainer approves it with two-factor authentication:
//
//   npm stage list            what is waiting
//   npm stage approve <id>    release it
//
// Packages are packed by pnpm, which turns workspace links into versions and
// applies publishConfig, then staged with provenance through trusted
// publishing, so no npm token is involved. Each version also gets its git tag
// and GitHub release, named like the npm version (@nodrail/client@1.2.3). The
// tag marks a version as done, so running this again changes nothing.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Staging needs npm 11.15 or later, so it's pinned rather than taken from Node.
const NPM = "npm@12.2.2";
const PACKAGES = ["packages/policy-engine", "packages/client"];
const dryRun = process.argv.includes("--dry-run");

const npm = (args, options = {}) =>
  execFileSync("npx", ["--yes", NPM, ...args], {
    encoding: "utf8",
    ...options,
  });

function isLive(name, version) {
  try {
    // A version npm doesn't have yet answers 404; that's the expected case.
    const found = npm(["view", `${name}@${version}`, "version"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    return found.trim() === version;
  } catch {
    return false;
  }
}

function hasRelease(tag) {
  try {
    execFileSync("gh", ["release", "view", tag], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// What changed in this version, from the package's changelog.
function changesIn(directory, version) {
  const changelog = readFileSync(join(directory, "CHANGELOG.md"), "utf8");
  const start = changelog.indexOf(`## ${version}\n`);
  if (start < 0) return "";
  const body = changelog.slice(start).split("\n").slice(1);
  const end = body.findIndex((line) => line.startsWith("## "));
  return (end < 0 ? body : body.slice(0, end)).join("\n").trim();
}

function release(directory, name, version, staged) {
  const tag = `${name}@${version}`;
  const npmPage = `https://www.npmjs.com/package/${name}/v/${version}`;
  const notes = [
    changesIn(directory, version),
    staged
      ? `Staged on npm with provenance. It installs once a maintainer approves it: ${npmPage}`
      : `On npm: ${npmPage}`,
  ].join("\n\n");
  if (dryRun) return console.log(`Would release ${tag}.`);
  execFileSync(
    "gh",
    [
      "release",
      "create",
      tag,
      "--target",
      process.env.GITHUB_SHA ?? "main",
      "--title",
      `${name} ${version}`,
      "--notes",
      notes,
    ],
    { stdio: "inherit" },
  );
}

const folder = mkdtempSync(join(tmpdir(), "nodrail-stage-"));
try {
  for (const directory of PACKAGES) {
    const { name, version } = JSON.parse(
      readFileSync(join(directory, "package.json"), "utf8"),
    );
    if (hasRelease(`${name}@${version}`)) {
      console.log(`${name}@${version} is already released.`);
      continue;
    }
    // Staged earlier but not yet tagged: only the release is missing.
    if (isLive(name, version)) {
      release(directory, name, version, false);
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
    release(directory, name, version, true);
    console.log(
      `${name}@${version} is staged. Approve it with: npm stage list`,
    );
  }
} finally {
  rmSync(folder, { recursive: true, force: true });
}
