// The revision the work is at, as the runtime observes it, for gate
// requirements with `subject: revision`: the commit, plus the uncommitted
// changes (tracked diffs, and untracked files by name and content). Two
// readings are equal only when nothing in the work tree changed between
// them. Anything that can't be read makes the revision unknown, never a
// match. Node only.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

/** All of git's work for one reading, so a hook stays inside its host's time limit. */
const TOTAL_MS = 5000;
/** Past this much diff, the revision is unknown rather than read slowly. */
const MAX_OUTPUT = 32 * 1024 * 1024;
/** Past this many untracked files, the revision is unknown. */
const MAX_UNTRACKED = 2000;

type Reader = (args: string[], input?: string) => Buffer | null;

function reader(cwd: string): Reader {
  const deadline = Date.now() + TOTAL_MS;
  return (args, input) => {
    const left = deadline - Date.now();
    if (left <= 0) return null;
    const result = spawnSync("git", args, {
      cwd,
      encoding: "buffer",
      timeout: left,
      maxBuffer: MAX_OUTPUT,
      // A Buffer: Node encodes string input with `encoding`, and "buffer"
      // isn't one, so a string here would make every untracked file unknown.
      ...(input === undefined ? {} : { input: Buffer.from(input, "utf8") }),
    });
    if (result.error || result.status !== 0) return null;
    return result.stdout;
  };
}

/** Untracked files by name and content, or null when they can't all be read. */
function untracked(git: Reader) {
  const others = git(["ls-files", "--others", "--exclude-standard", "-z"]);
  if (!others) return null;
  const names = others.toString("utf8").split("\0").filter(Boolean);
  // A name with a newline can't go through --stdin-paths: unknown, not guessed.
  if (names.length > MAX_UNTRACKED || names.some((name) => name.includes("\n")))
    return null;
  if (!names.length) return [others];
  const contents = git(
    ["hash-object", "--stdin-paths", "--no-filters"],
    `${names.join("\n")}\n`,
  );
  return contents ? [others, contents] : null;
}

/**
 * `sha256:` over HEAD, the tracked changes against it and the untracked
 * files, or null when git can't say (no repository, no commit, out of time,
 * too much to read).
 */
export function workRevision(cwd: string): string | null {
  // Read from the top of the work tree: from a folder below it, ls-files
  // would list only that folder's untracked files, relative to it, and
  // hash-object would look for them from the top. Same work, same revision.
  const top = reader(cwd)(["rev-parse", "--show-toplevel"]);
  const root = top?.toString("utf8").replace(/\n$/, "");
  if (!root) return null;
  const git = reader(root);
  const head = git(["rev-parse", "--verify", "HEAD"]);
  const diff =
    head && git(["diff", "HEAD", "--binary", "--no-ext-diff", "--no-color"]);
  const others = diff && untracked(git);
  if (!head || !diff || !others) return null;
  return digestOf([head, diff, ...others]);
}

function digestOf(parts: Buffer[]) {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(`${part.length}\n`).update(part);
  return `sha256:${hash.digest("hex")}`;
}

/** A full commit id as git prints it: 40 hex (SHA-1) or 64 hex (SHA-256). */
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * The revision `workRevision` reads on a clean checkout of `commit`: no
 * tracked change and no untracked file. Computed from the commit alone, so
 * a server can tie CI evidence for a commit to the exact local subject.
 * Null for anything that isn't a full lowercase commit id.
 */
export function cleanRevision(commit: string): string | null {
  if (!COMMIT.test(commit)) return null;
  const empty = Buffer.alloc(0);
  return digestOf([Buffer.from(`${commit}\n`), empty, empty]);
}
