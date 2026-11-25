import { lstatSync, opendirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { canonicalPath, pathWithinLimits } from "./paths.ts";
import { globSegment } from "./secrets.ts";
import { GLOB } from "./shell-globs.ts";

const missing = (error: unknown) =>
  ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");

/** Share the inspection budget across every brace alternative of one word. */
export function globBudget() {
  let work = 4096;
  let results = 500;
  return {
    spend: (cost = 1) => (work -= cost) >= 0,
    result: () => --results >= 0,
  };
}

function reachesPath(path: string, namesPath: (path: string) => boolean) {
  try {
    lstatSync(path);
  } catch (error) {
    return !missing(error);
  }
  try {
    return namesPath(realpathSync.native(path));
  } catch (error) {
    // A dangling final link can still select the destination of a write.
    return !missing(error) || namesPath(canonicalPath(path));
  }
}

function someEntry(path: string, matches: (name: string) => boolean) {
  try {
    const entries = opendirSync(path);
    try {
      for (let item = entries.readSync(); item; item = entries.readSync()) {
        if (matches(item.name)) return true;
      }
      return false;
    } finally {
      entries.closeSync();
    }
  } catch (error) {
    return !missing(error);
  }
}

function candidateMatcher(segment: string) {
  if (!GLOB.test(segment)) return null;
  const folded = globSegment(segment);
  const exact = globSegment(segment, false);
  // Case folding a negated set can exclude a name a case-sensitive shell
  // would select. Character classes also vary with the shell's locale.
  const characterPattern = /[?[]/.test(segment);
  return (name: string) =>
    (characterPattern && /[^\p{ASCII}]/u.test(name)) ||
    exact(name) ||
    folded(name);
}

/** A wildcard reaches data when a selected path names it on disk, or when
 * an error or exhausted budget prevents inspection. */
export function diskGlobReaches(
  folder: string,
  rest: string[],
  budget: ReturnType<typeof globBudget>,
  namesPath: (path: string) => boolean,
) {
  const matchers = rest.map(candidateMatcher);
  function visit(path: string, at: number): boolean {
    if (!budget.spend() || !pathWithinLimits(path)) return true;
    const segment = rest[at];
    if (segment === undefined)
      return !budget.result() || reachesPath(path, namesPath);
    const matches = matchers[at];
    if (!matches) return visit(join(path, segment), at + 1);
    const recursive = segment === "**";
    if (recursive && visit(path, at + 1)) return true;
    return someEntry(path, (name) => {
      // Segment matching costs time proportional to both string lengths.
      if (!budget.spend(1 + Math.ceil((segment.length * name.length) / 256)))
        return true;
      if (name.startsWith(".") && !segment.startsWith(".")) return false;
      return matches(name) && visit(join(path, name), at + (recursive ? 0 : 1));
    });
  }
  return visit(folder, 0);
}
