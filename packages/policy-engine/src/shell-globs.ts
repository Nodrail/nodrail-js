import { homedir } from "node:os";
import { isAbsolute, join, parse, resolve, sep } from "node:path";
import { canonicalPath, pathWithinLimits, withoutNamespace } from "./paths.ts";

export const GLOB = /[*?[]/;
const separator = sep === "\\" ? /[\\/]/ : /\//;

/** A wildcard word's canonical literal folder and remaining segments. */
export function wildcardParts(word: string, cwd: string) {
  const expanded = word.replace(/^~(?=$|[\\/])/, homedir());
  const written = sep === "\\" ? withoutNamespace(expanded) : expanded;
  // Keep the wildcard before any `..` so it cannot be normalized away.
  const base = sep === "\\" ? withoutNamespace(cwd) : cwd;
  const full = isAbsolute(written) ? written : `${base}${sep}${written}`;
  if (!pathWithinLimits(full)) return null;
  const { root } = parse(full);
  const parts = full.slice(root.length).split(separator).filter(Boolean);
  const first = parts.findIndex((part) => GLOB.test(part));
  if (first < 0) return null;
  return {
    folder: canonicalPath(resolve(base, join(root, ...parts.slice(0, first)))),
    rest: parts.slice(first),
  };
}
