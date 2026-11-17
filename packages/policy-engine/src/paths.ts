// Paths as rules see them: resolved, canonical, and split into named parts.
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { nameForms } from "./secrets.ts";

/**
 * The real path where it can be known: symlinks followed, and the disk's own
 * casing, so .CLAUDE can't pass for something other than .claude.
 */
export function canonicalPath(path: string, hops = 0): string {
  const missing: string[] = [];
  let existing = path;
  for (;;) {
    try {
      return join(realpathSync.native(existing), ...[...missing].reverse());
    } catch {
      // A link to a file not there yet: writing through it creates its
      // target, so the target is what is judged, not the link's own name.
      const target = linkTarget(existing);
      if (target !== null && hops < MAX_LINKS)
        return canonicalPath(
          join(resolve(dirname(existing), target), ...[...missing].reverse()),
          hops + 1,
        );
      const parent = dirname(existing);
      if (parent === existing) return path;
      missing.push(basename(existing));
      existing = parent;
    }
  }
}

/** How many links in a row are followed; a longer chain is a loop. */
const MAX_LINKS = 40;

function linkTarget(path: string) {
  try {
    return lstatSync(path).isSymbolicLink() ? readlinkSync(path) : null;
  } catch {
    return null;
  }
}

/**
 * Lets a rule name one folder or file anywhere in a path. A dot file with a
 * suffix also answers to its base, so .env.staging contains .env.
 */
export const partsOf = (path: string) => [
  ...new Set(path.split(/[\\/]/).filter(Boolean).flatMap(nameForms)),
];

/**
 * The file's own name, exactly as written: the last part of the path. Unlike
 * path_parts, a folder that happens to share a name can't match it.
 */
export const fileName = (path: string) => path.split(/[\\/]/).pop() ?? "";

/** Longer or deeper paths aren't real, and would only make checking slow. */
const MAX_PATH = 4096;
const MAX_DEPTH = 256;

export function fullPath(raw: string, cwd: string | null) {
  if (raw.length > MAX_PATH) return null;
  const expanded = /^~(?=$|\/)/.test(raw) ? `${homedir()}${raw.slice(1)}` : raw;
  // Resolved, so src/../.claude can't pass as a path inside src/.
  if (!isAbsolute(expanded) && !cwd) return null;
  const absolute = resolve(cwd ?? "/", expanded);
  if (absolute.split(/[\\/]/).length > MAX_DEPTH) return null;
  return canonicalPath(absolute);
}

/**
 * Whether a path is inside the folder the agent works in. Unknown without a
 * working folder, and a missing value never helps a rule allow anything.
 */
export function insideCwd(
  path: string,
  cwd: string | null,
): Record<string, boolean> {
  const root = cwd ? fullPath(cwd, null) : null;
  return root ? { inside_cwd: isWithin(path, root) } : {};
}

export function isWithin(path: string, root: string) {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return path === root || path.startsWith(prefix);
}

/** Whether every path is inside the working folder, resolved once. */
export function insideAll(
  paths: string[],
  cwd: string | null,
): Record<string, boolean> {
  const root = cwd ? fullPath(cwd, null) : null;
  return root
    ? { inside_cwd: paths.every((path) => isWithin(path, root)) }
    : {};
}

/** Whether searching this folder takes in the whole home folder. */
export function containsHome(path: string) {
  const home = canonicalPath(homedir());
  return isWithin(home, path);
}
