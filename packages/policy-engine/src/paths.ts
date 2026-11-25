// Paths as rules see them: resolved, canonical, and split into named parts.
import { lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import native, {
  basename,
  dirname,
  isAbsolute,
  join,
  resolve,
  win32,
} from "node:path";
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
const separator = native === win32 ? /[\\/]/ : /\//;

export const pathWithinLimits = (path: string) =>
  path.length <= MAX_PATH &&
  path.split(separator).filter(Boolean).length <= MAX_DEPTH;

export function fullPath(raw: string, cwd: string | null) {
  if (!pathWithinLimits(raw)) return null;
  const expanded = (native === win32 ? /^~(?=$|[\\/])/ : /^~(?=$|\/)/).test(raw)
    ? `${homedir()}${raw.slice(1)}`
    : raw;
  // Resolved, so src/../.claude can't pass as a path inside src/.
  if (!isAbsolute(expanded) && !cwd) return null;
  const absolute = resolve(cwd ?? "/", expanded);
  if (!pathWithinLimits(absolute)) return null;
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
  return root ? { inside_cwd: isWithinOnDisk(path, root) } : {};
}

/** The ordinary drive or UNC spelling of a Windows namespaced path. */
export function withoutNamespace(path: string) {
  return path
    .replace(/^[\\/]{2}\?[\\/]UNC[\\/]/i, "\\\\")
    .replace(/^[\\/]{2}\?[\\/](?=[a-z]:[\\/])/i, "");
}

export function relativePath(root: string, path: string, flavor = native) {
  if (flavor === win32) {
    root = withoutNamespace(root);
    path = withoutNamespace(path);
  }
  const result = flavor.relative(root, path);
  return result === ".." ||
    result.startsWith(`..${flavor.sep}`) ||
    flavor.isAbsolute(result)
    ? null
    : result;
}

export function isWithin(path: string, root: string, flavor = native) {
  return relativePath(root, path, flavor) !== null;
}

/** Paths are canonicalized through the nearest existing ancestor by fullPath. */
export function isWithinOnDisk(path: string, root: string, flavor = native) {
  const relative = relativePath(root, path, flavor);
  if (relative === null) return false;
  if (flavor !== win32) return true;
  // Verify the project boundary on disk. Its descendants may not exist yet,
  // and a case-sensitive sibling can have the same folded name as the root.
  let ancestor = win32.normalize(withoutNamespace(path));
  for (const _ of relative.split("\\").filter(Boolean))
    ancestor = win32.dirname(ancestor);
  try {
    const candidate = statSync(ancestor, { bigint: true });
    const project = statSync(withoutNamespace(root), { bigint: true });
    return (
      candidate.isDirectory() &&
      project.isDirectory() &&
      project.ino !== 0n &&
      candidate.dev === project.dev &&
      candidate.ino === project.ino
    );
  } catch {
    return false;
  }
}

/** Whether every path is inside the working folder, resolved once. */
export function insideAll(
  paths: string[],
  cwd: string | null,
): Record<string, boolean> {
  const root = cwd ? fullPath(cwd, null) : null;
  return root
    ? { inside_cwd: paths.every((path) => isWithinOnDisk(path, root)) }
    : {};
}

/** Whether searching this folder takes in the whole home folder. */
export function containsHome(path: string) {
  const home = canonicalPath(homedir());
  return isWithin(home, path);
}
