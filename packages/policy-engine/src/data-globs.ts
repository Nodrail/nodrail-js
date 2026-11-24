import { statSync } from "node:fs";
import { sep } from "node:path";
import { diskGlobReaches, globBudget } from "./data-glob-disk.ts";
import { fullPath, isWithin, relativePath } from "./paths.ts";
import type { DataGuard, DataPlace } from "./rules-guard.ts";
import { expandBraces, globSegment } from "./secrets.ts";
import { GLOB, wildcardParts } from "./shell-globs.ts";

const segments = (path: string) => path.split(sep).filter(Boolean);
const shellSeparator = sep === "\\" ? /[\\/]/ : /\//;
const specialClass = /\[[.:=][^[\]]+[.:=]\]/;

function unsupportedGlob(pattern: string) {
  return (
    (sep !== "\\" && pattern.includes("\\")) ||
    specialClass.test(pattern) ||
    pattern.split(shellSeparator).includes("..")
  );
}

/**
 * Reachable depths along one protected path. An exhausted pattern can name
 * a containing folder in the project. A pattern that reaches the protected
 * path before exhausting its segments could name something inside it.
 */
function reaches(
  pattern: string[],
  names: string[],
  ancestorDepth: number,
  directory: () => boolean,
) {
  let row = names.map(() => false).concat(false);
  row[0] = true;
  for (const segment of pattern) {
    if (row[names.length] && directory()) return true;
    if (segment === ".") continue;
    if (segment === "**") {
      for (let depth = 1; depth <= names.length; depth += 1)
        row[depth] ||= row[depth - 1]!;
    } else {
      const matches = globSegment(segment);
      row = [false, ...names.map((name, at) => row[at]! && matches(name))];
    }
  }
  return row[names.length] || row.some((hit, at) => hit && at > ancestorDepth);
}

export const dataGlob = /[*?[{]/;

function isDirectory(path: string) {
  try {
    return statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
  } catch {
    return false;
  }
}

function reachesProtected(
  folder: string,
  rest: string[],
  project: string,
  protectedPath: string,
) {
  if (isWithin(folder, protectedPath)) return true;
  const relative = relativePath(folder, protectedPath);
  if (relative === null) return false;
  const projectRelative = relativePath(folder, project);
  const ancestorDepth =
    projectRelative !== null
      ? segments(projectRelative).length
      : isWithin(folder, project)
        ? -1
        : Infinity;
  return reaches(rest, segments(relative), ancestorDepth, () =>
    isDirectory(protectedPath),
  );
}

/** Check the protected names and the canonical targets selected on disk. */
export function dataGlobReaches(
  word: string,
  cwd: string,
  { root, places }: DataGuard,
  namesPath: (path: string) => DataPlace | undefined,
): DataPlace | undefined {
  const uncertain = places[0];
  const alternatives = expandBraces(word);
  if (!alternatives) return uncertain;
  // Quoted braces stay literal even when the same word has active wildcards.
  if (alternatives.length > 1 && GLOB.test(word)) alternatives.push(word);
  const budget = globBudget();
  for (const alternative of alternatives) {
    if (!GLOB.test(alternative)) {
      const path = fullPath(alternative, cwd);
      if (path === null) return uncertain;
      const place = namesPath(path);
      if (place) return place;
      continue;
    }
    if (unsupportedGlob(alternative)) return uncertain;
    const parts = wildcardParts(alternative, cwd);
    if (!parts) return uncertain;
    const { folder, rest } = parts;
    const place = places.find(({ path }) =>
      reachesProtected(folder, rest, root, path),
    );
    if (place) return place;
    let alias: DataPlace | undefined;
    if (
      diskGlobReaches(folder, rest, budget, (path) => {
        alias = namesPath(path);
        return alias !== undefined;
      })
    )
      return alias ?? uncertain;
  }
  return undefined;
}
