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
  const words = command.split(/[\s;|&<>()`'"=:$]+/).filter(Boolean);
  for (const word of words) {
    if (
      NODRAIL_PROGRAMS.has(basename(word)) ||
      /@nodrail\/(?:cli|policy-engine)/.test(word)
    )
      return word;
    const path = canonicalPath(
      resolve(cwd, word.replace(/^~(?=$|\/)/, homedir())),
    );
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
