// The hook never lets an agent change the rules it enforces. Rules in the
// files can be wrong or missing; this holds whatever they say.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { CHANGING_FILE_OPERATIONS } from "./changes.ts";
import { canonicalPath, isWithin } from "./paths.ts";
import type { ActionDescriptor } from "./protocol.ts";

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

/** A setup's project folder and the paths in it no agent may touch. */
export type SetupGuard = { root: string; paths: string[] };

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
 * command naming it, or a folder in the project holding it. A wildcard word
 * counts by the folder before it: `cat memory/*` names `memory`.
 */
export function touchedData(
  action: ActionDescriptor,
  command: string | null,
  cwd: string,
  guard: DataGuard,
): DataPlace | null {
  const { root, places } = guard;
  if (places.length === 0) return null;
  const within = (path: string) =>
    places.find(
      (place) =>
        isWithin(path, place.path) ||
        (path !== root && isWithin(path, root) && isWithin(place.path, path)),
    ) ?? null;
  const paths =
    action.tool === "files"
      ? [...targets(action), action.resource.id]
      : action.tool === "shell" && command
        ? words(command).map((word) =>
            wordPath(word.replace(/[*?[{].*$/, ""), cwd),
          )
        : [];
  for (const path of paths) {
    const place = within(path);
    if (place) return place;
  }
  return null;
}

const words = (command: string) =>
  command.split(/[\s;|&<>()`'"=:$]+/).filter(Boolean);

const wordPath = (word: string, cwd: string) =>
  canonicalPath(resolve(cwd, word.replace(/^~(?=$|\/)/, homedir())));

const NODRAIL_PROGRAMS = new Set([
  "nodrail",
  "nodrail-policy",
  "nodrail-claude-hook",
]);

/**
 * What in a shell command touches the setup, or null. A shell command can
 * write any file it names, and none of its words can be trusted to only
 * read, so a command naming a setup path at all is refused, as is Nodrail
 * itself run by any path or through a package runner. Words are read
 * leniently: quotes and shell punctuation split them, so a quoted or joined
 * path still counts. A word naming the project folder itself doesn't, or
 * every command run on the whole project would be refused.
 */
export function touchedSetup(
  command: string,
  cwd: string,
  guard: SetupGuard,
): string | null {
  for (const word of words(command)) {
    if (
      NODRAIL_PROGRAMS.has(basename(word)) ||
      /@nodrail\/(?:cli|policy-engine)/.test(word)
    )
      return word;
    const path = wordPath(word, cwd);
    for (const protectedPath of guard.paths) {
      if (isWithin(path, protectedPath)) return word;
      // A folder holding a setup path, inside the project: rm -r resources.
      if (
        path !== guard.root &&
        isWithin(path, guard.root) &&
        isWithin(protectedPath, path)
      )
        return word;
    }
  }
  return null;
}
