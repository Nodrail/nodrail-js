// The hook never lets an agent change the rules it enforces. Rules in the
// files can be wrong or missing; this holds whatever they say.
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { CHANGING_FILE_OPERATIONS } from "./changes.ts";
import {
  canonicalPath,
  fullPath,
  isWithin,
  pathWithinLimits,
  relativePath,
} from "./paths.ts";
import { dataGlob, dataGlobReaches } from "./data-globs.ts";
import { COPILOT_PLACES, SETUP_PLACES } from "./project-team.ts";
import type { ActionDescriptor } from "./protocol.ts";
import { shellWords } from "./commands.ts";
import { globSegment } from "./secrets.ts";
import { GLOB, wildcardParts } from "./shell-globs.ts";
import { writesOntoRoot } from "./shell-writes.ts";
import {
  git,
  ledgerDirectory,
  nodrailDirectory,
  type Environment,
} from "./run-key.ts";

export { GLOB, wildcardParts } from "./shell-globs.ts";

/** The rule files and folders the hook loaded, as file tools name paths. */
export function protectedPaths(paths: string[], cwd = process.cwd()) {
  return paths.map((path) => canonicalPath(resolve(cwd, path)));
}

/**
 * The files a protect list names. Each line is a path from the project
 * folder, the one that holds the list's own folder (`<project>/.nodrail/
 * protected.txt`), so the list works wherever the project is. Blank lines
 * and lines starting with `#` are skipped. A list that can't be read throws:
 * the hook must block then, not run unprotected.
 */
export function listedPaths(list: string) {
  const file = resolve(list);
  const project = dirname(dirname(file));
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => canonicalPath(resolve(project, line)));
}

/** Every path a file change touches. */
function targets(action: ActionDescriptor) {
  const { paths } = action.params as { paths?: unknown };
  if (action.operation === "file.patch" && Array.isArray(paths))
    return paths.filter((path): path is string => typeof path === "string");
  return [action.resource.id];
}

/**
 * The rules file or folder a file change would touch, or null. Writes, edits,
 * deletes, patches and notebook edits are all changes.
 */
export function touchedRules(
  action: ActionDescriptor,
  rules: readonly string[],
): string | null {
  if (
    action.tool !== "files" ||
    !CHANGING_FILE_OPERATIONS.has(action.operation)
  )
    return null;
  for (const target of targets(action))
    if (rules.some((rule) => isWithin(target, rule))) return target;
  return null;
}

/**
 * A setup's project folder and the paths in it no agent may touch. `roots`:
 * places no wildcard may reach either (the run ledger, git's folders).
 */
export type SetupGuard = { root: string; paths: string[]; roots?: string[] };

/** The setup a protect list names, the list, and the writes nodrail stages at home. */
export function setupGuard(list: string): SetupGuard {
  const root = canonicalPath(dirname(dirname(resolve(list))));
  return {
    root,
    paths: [
      ...listedPaths(list),
      // The list itself, and where nodrail stages its writes.
      canonicalPath(resolve(list)),
      canonicalPath(join(homedir(), ".nodrail")),
    ],
  };
}

/** The installed hook's own files remain protected even without the list. */
export function connectedSetup(file: string, home = homedir()): SetupGuard {
  const root = canonicalPath(dirname(dirname(resolve(file))));
  return {
    root,
    paths: protectedPaths(
      [
        ...SETUP_PLACES,
        ...COPILOT_PLACES,
        resolve(file),
        join(home, ".nodrail"),
      ],
      root,
    ),
  };
}

/**
 * The run ledger, wherever it resolves for this folder, and the session pins
 * kept with it: `NODRAIL_LEDGER` when set, else Nodrail's directory
 * (`.git/nodrail`, or ~/.nodrail outside git). The hook and the person's
 * `nodrail evidence run` write there; an agent never may, or it could
 * forge the steps, reservations and evidence a gate reads.
 */
export function ledgerGuardPath(cwd: string, env: Environment) {
  return canonicalPath(
    env.NODRAIL_LEDGER ? ledgerDirectory(cwd, env) : nodrailDirectory(cwd, env),
  );
}

/**
 * Git's own folders for this folder: the worktree's and the shared
 * one, which hold its hooks, its config and Nodrail's ledger. Git commands
 * change them through `git`, never by naming them.
 */
function gitFolders(cwd: string) {
  return ["--git-dir", "--git-common-dir"].flatMap((flag) => {
    const found = git(cwd, ["rev-parse", flag]);
    return found ? [canonicalPath(resolve(cwd, found))] : [];
  });
}

/**
 * The setup guard with the run ledger and git's folders, as seen from each
 * folder, protected too, and kept from any wildcard.
 */
export function withLedger(
  guard: SetupGuard,
  cwds: string[],
  env: Environment,
): SetupGuard {
  const roots = [
    canonicalPath(join(guard.root, ".git")),
    ...[...new Set(cwds)].flatMap((cwd) => [
      ledgerGuardPath(cwd, env),
      ...gitFolders(cwd),
    ]),
  ];
  return {
    ...guard,
    paths: [...new Set([...guard.paths, ...roots])],
    roots: [...new Set([...(guard.roots ?? []), ...roots])],
  };
}

/** A connection's data: where it is, and the connection that keeps it. */
export type DataPlace = { path: string; connection: string };

/** The project folder and the data its connections keep in it. */
export type DataGuard = { root: string; places: DataPlace[] };

/**
 * The data each connection keeps, from the connections file: its paths are
 * from the project folder, the one that holds the file's own folder.
 */
export function dataGuard(
  file: string,
  calls: Record<string, { data?: string[] }>,
): DataGuard {
  const root = canonicalPath(dirname(dirname(resolve(file))));
  return {
    root,
    places: Object.entries(calls).flatMap(([connection, { data }]) =>
      (data ?? []).map((path) => ({
        path: canonicalPath(resolve(root, path)),
        connection,
      })),
    ),
  };
}

/**
 * The data a call reaches outside its connection, or null: a file tool on
 * a path in it, reading or changing; a search from inside it; a shell
 * command naming it, or a folder in the project holding it. Shell glob
 * alternatives count when they can select a protected path.
 */
export function touchedData(
  action: ActionDescriptor,
  command: string | null,
  cwd: string,
  guard: DataGuard,
): DataPlace | null {
  const { root, places } = guard;
  if (places.length === 0) return null;
  const named = (path: string) =>
    places.find((place) => namesProtected(path, place.path, root));
  if (action.tool === "files") {
    for (const path of [...targets(action), action.resource.id]) {
      const place = named(path);
      if (place) return place;
    }
  }
  if (action.tool !== "shell" || !command) return null;
  for (const word of namedWords(command)) {
    const path = fullPath(word, cwd);
    if (path === null) return places[0]!;
    const place =
      named(path) ??
      (dataGlob.test(word)
        ? dataGlobReaches(word, cwd, guard, named)
        : undefined);
    if (place) return place;
  }
  return null;
}

function namesProtected(path: string, protectedPath: string, root: string) {
  const inside = relativePath(root, path);
  return (
    isWithin(path, protectedPath) ||
    (inside !== null && inside !== "" && isWithin(protectedPath, path))
  );
}

const words = (command: string) =>
  command.split(/[\s;|&<>()`'"=:$]+/).filter(Boolean);

export const wordPath = (word: string, cwd: string) =>
  canonicalPath(resolve(cwd, word.replace(/^~(?=$|\/)/, homedir())));

const NODRAIL_PROGRAMS = new Set([
  "nodrail",
  "nodrail-policy",
  "nodrail-claude-hook",
]);

/** Every word a line names: read leniently, and as the shell joins quotes. */
function namedWords(command: string) {
  const joined = (shellWords(command) ?? []).flatMap((word) => [
    word,
    ...word.split("="),
    ...word.split(/[=:]/),
  ]);
  return [...new Set([...words(command), ...joined])].filter(Boolean);
}

/** Whether a segment as written could name `name`; a wildcard skips dotfiles. */
function segmentMatches(segment: string, name: string) {
  if (!GLOB.test(segment)) return segment.toLowerCase() === name.toLowerCase();
  if (name.startsWith(".") && !segment.startsWith(".")) return false;
  return globSegment(segment)(name);
}

/** At most this many paths a wildcard is expanded to; more could be anything. */
const MAX_EXPANDED = 500;

/**
 * The paths a wildcard names on disk now, as the shell would expand it,
 * links followed by the caller; null when there are too many to read.
 */
export function expandWildcard(
  folder: string,
  rest: string[],
): string[] | null {
  let found = [folder];
  for (const segment of rest) {
    if (!GLOB.test(segment)) {
      found = found.map((path) => join(path, segment));
      continue;
    }
    const next: string[] = [];
    for (const path of found) {
      let names: string[] = [];
      try {
        names = readdirSync(path);
      } catch {
        continue;
      }
      for (const name of names)
        if (segmentMatches(segment, name)) next.push(join(path, name));
      if (next.length > MAX_EXPANDED) return null;
    }
    found = next;
  }
  return found;
}

/**
 * Whether a wildcard word could name a root, a folder holding one, or a
 * path inside one: `.gi?/nodrail/x`, `.c*`, `sub/alt*`. Its literal
 * folders are resolved; what follows the first wildcard is matched segment
 * by segment, and a `..` after it could go anywhere. What it names on disk
 * is checked as literal paths too, so a link (`sub/g*` to `.git`) counts.
 */
function wildcardReaches(
  word: string,
  cwd: string,
  roots: string[],
  named: (path: string) => boolean,
) {
  const parts = wildcardParts(word, cwd);
  if (!parts) return false;
  const { folder, rest } = parts;
  if (rest.includes("..")) return true;
  const pattern = [...folder.split(sep).filter(Boolean), ...rest];
  const byPattern = roots.some((root) => {
    const names = root.split(sep).filter(Boolean);
    const shared = Math.min(names.length, pattern.length);
    for (let at = 0; at < shared; at += 1)
      if (!segmentMatches(pattern[at]!, names[at]!)) return false;
    return true;
  });
  if (byPattern) return true;
  const expanded = expandWildcard(folder, rest);
  return (
    expanded === null || expanded.some((path) => named(canonicalPath(path)))
  );
}

/**
 * The places no wildcard may reach: the guard's roots, and the setup's
 * dot folders in the project (`.nodrail`, `.claude`, …).
 */
function wildcardRoots(guard: SetupGuard) {
  const dotted = guard.paths.filter((path) => {
    const inside = relative(guard.root, path);
    return inside.startsWith(".") && !inside.startsWith("..");
  });
  return [...new Set([...(guard.roots ?? []), ...dotted])];
}

/**
 * What in a shell command touches the setup, or null. A shell command can
 * write any file it names, and none of its words can be trusted to only
 * read, so a command naming a setup path at all is refused, as is Nodrail
 * itself run by any path or through a package runner. Words are read
 * leniently (quotes and shell punctuation split them) and as the shell
 * joins them (`".git/nod""rail"`), so a quoted, joined or spliced path
 * still counts, and a wildcard that could reach git's folders, the ledger
 * or a setup dot folder counts too. A word naming the project folder
 * itself doesn't, or every command run on the whole project would be refused.
 */
export function touchedSetup(
  command: string,
  cwd: string,
  guard: SetupGuard,
): string | null {
  const roots = wildcardRoots(guard);
  const words = namedWords(command);
  const oversized = words.find(
    (word) => GLOB.test(word) && !pathWithinLimits(word),
  );
  if (oversized !== undefined) return oversized;
  const onto = writesOntoRoot(command, cwd, roots);
  if (onto !== null) return onto;
  for (const word of words) {
    if (
      NODRAIL_PROGRAMS.has(basename(word)) ||
      /@nodrail\/(?:cli|policy-engine)/.test(word)
    )
      return word;
    if (
      GLOB.test(word) &&
      wildcardReaches(word, cwd, roots, (path) =>
        namesSetupPath(path, { ...guard, paths: roots }),
      )
    )
      return word;
    if (namesSetupPath(wordPath(word, cwd), guard)) return word;
  }
  return null;
}

/** Whether a path is a setup path, in one, or a project folder holding one. */
function namesSetupPath(path: string, guard: SetupGuard) {
  return guard.paths.some((protectedPath) =>
    namesProtected(path, protectedPath, guard.root),
  );
}
