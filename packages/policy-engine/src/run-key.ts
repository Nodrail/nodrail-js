// Which run a hook event belongs to, and where the local run files are kept.
// No zod and no YAML: the Cloud hook bundles this and must stay small.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

export type Environment = Record<string, string | undefined>;

/** Run keys are at most this long, as runs take them. */
const MAX_KEY = 200;

/** Whatever git prints, or "" when it fails or isn't there. */
export function git(cwd: string, args: string[]) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 2000,
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

/**
 * Where Nodrail keeps local files for this folder: `nodrail` in the shared git
 * directory, so worktrees share it and it is never committed, or ~/.nodrail
 * outside git.
 */
export function nodrailDirectory(cwd: string) {
  const common = git(cwd, ["rev-parse", "--git-common-dir"]);
  if (!common) return join(homedir(), ".nodrail");
  return join(isAbsolute(common) ? common : resolve(cwd, common), "nodrail");
}

/** The run ledger: NODRAIL_LEDGER, else `runs` in the Nodrail directory. */
export function ledgerDirectory(cwd: string, env: Environment = process.env) {
  if (env.NODRAIL_LEDGER) return resolve(cwd, env.NODRAIL_LEDGER);
  return join(nodrailDirectory(cwd), "runs");
}

/** Session pins: inside a moved ledger, else next to the ledger. */
function sessionsDirectory(cwd: string, env: Environment) {
  if (env.NODRAIL_LEDGER)
    return join(resolve(cwd, env.NODRAIL_LEDGER), "sessions");
  return join(nodrailDirectory(cwd), "sessions");
}

/**
 * A remote as host/owner/name: no scheme, port, credentials or `.git`, so a
 * token in the remote's URL never reaches a run key. Null for a local remote.
 */
export function repositoryName(remote: string): string | null {
  let text = remote.trim();
  if (/^[a-z]:[\\/]/i.test(text)) return null; // a Windows path
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    // scp-like: [user@]host:owner/name
    const scp = /^(?:[^@/]+@)?([^/:]+):(?!\/)(.+)$/.exec(text);
    if (!scp) return null;
    text = `ssh://${scp[1]}/${scp[2]}`;
  }
  if (!URL.canParse(text)) return null;
  const { hostname, pathname } = new URL(text);
  const path = pathname
    .split("/")
    .filter(Boolean)
    .join("/")
    .replace(/\.git$/, "");
  if (!hostname || !path) return null;
  return `${hostname.toLowerCase()}/${path}`;
}

/** The branch every session starts from: origin's HEAD, else main or master. */
function isDefaultBranch(cwd: string, branch: string) {
  const head = git(cwd, [
    "symbolic-ref",
    "--quiet",
    "refs/remotes/origin/HEAD",
  ]);
  if (head) return head === `refs/remotes/origin/${branch}`;
  return branch === "main" || branch === "master";
}

/**
 * `<repo>/<branch>`, or `session:<id>` on the default branch, on a detached
 * HEAD or outside git, where a branch doesn't name one piece of work.
 */
function computeKey(cwd: string, sessionId: string | null) {
  const session = sessionId ? `session:${sessionId}` : null;
  const branch = git(cwd, ["branch", "--show-current"]);
  if (!branch || isDefaultBranch(cwd, branch)) return session;
  const remote = repositoryName(git(cwd, ["remote", "get-url", "origin"]));
  const repo = remote ?? basename(git(cwd, ["rev-parse", "--show-toplevel"]));
  return repo ? `${repo}/${branch}` : branch;
}

/**
 * The key pinned to a session. The first event of a session stores it, and
 * every later one reuses it, so switching branch can't move work to a run
 * with no history. The first writer wins: a file created only if missing.
 */
function pinned(file: string, key: () => string | null) {
  try {
    const kept = readFileSync(file, "utf8").trim();
    if (kept) return kept.slice(0, MAX_KEY);
  } catch {
    // Not pinned yet.
  }
  const computed = key()?.slice(0, MAX_KEY) ?? null;
  if (!computed) return null;
  try {
    writeFileSync(file, computed, { flag: "wx" });
    return computed;
  } catch {
    // Another event of this session pinned it first, or the folder is read-only.
    try {
      return readFileSync(file, "utf8").trim().slice(0, MAX_KEY) || computed;
    } catch {
      return computed;
    }
  }
}

/**
 * The run a call belongs to. NODRAIL_RUN when set; otherwise the key pinned
 * to the session: `<repo>/<branch>` where the session started, or
 * `session:<id>` on the default branch. Null with neither a run nor a session.
 */
export function runKey(
  cwd: string,
  sessionId: string | null,
  env: Environment = process.env,
): string | null {
  const named = env.NODRAIL_RUN?.trim();
  if (named) return named.slice(0, MAX_KEY);
  if (!sessionId) return computeKey(cwd, null)?.slice(0, MAX_KEY) ?? null;
  const directory = sessionsDirectory(cwd, env);
  try {
    mkdirSync(directory, { recursive: true });
  } catch {
    // Unpinned, the key is still the right one for this event.
  }
  const name = createHash("sha256").update(sessionId).digest("hex");
  return pinned(join(directory, name.slice(0, 32)), () =>
    computeKey(cwd, sessionId),
  );
}
