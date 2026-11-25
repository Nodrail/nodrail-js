// What a shell line writes onto a protected root without naming it:
// a link pointing at one or above one, and a tree copied, moved, synced or
// extracted where it would create or overwrite one. Best effort, like every
// read of a shell line: a control, not a sandbox.
import { readdirSync } from "node:fs";
import { basename, dirname, relative, sep } from "node:path";
import { makesLink, programWords } from "./commands.ts";
import { isWithin } from "./paths.ts";
import {
  expandWildcard,
  GLOB,
  wildcardParts,
  wordPath,
} from "./rules-guard.ts";

/** The arguments that aren't options, `--` ending the options. */
function operands(args: string[]) {
  const end = args.indexOf("--");
  const options = end < 0 ? args : args.slice(0, end);
  return [
    ...options.filter((word) => !word.startsWith("-") || word === "-"),
    ...(end < 0 ? [] : args.slice(end + 1)),
  ];
}

/** An option's value, as `-C dir`, `-Cdir`, `--directory dir` or `--directory=dir`. */
function optionValue(
  args: string[],
  short: string | null,
  long: string | null,
) {
  for (let at = 0; at < args.length; at += 1) {
    const word = args[at]!;
    if (short && word === short) return args[at + 1] ?? null;
    if (short && word.startsWith(short) && !word.startsWith("--"))
      return word.slice(short.length);
    if (long && word === long) return args[at + 1] ?? null;
    if (long && word.startsWith(`${long}=`)) return word.slice(long.length + 1);
  }
  return null;
}

const shortFlags = (args: string[], letters: RegExp) =>
  args.some((word) => /^-[^-]/.test(word) && letters.test(word.slice(1)));

const recursive = (args: string[], letters: RegExp) =>
  shortFlags(args, letters) ||
  args.some((word) => /^--(?:recursive|archive)$/.test(word));

/** A tree a command writes: where to, from what, and how it reads sources. */
type TreeCopy = {
  to: string;
  sources: string[];
  /** `SRC/` copies SRC's contents (rsync), not SRC itself. */
  slashIsContents: boolean;
  /** An archive: what it holds can't be read from the line. */
  opaque: boolean;
};

/** `-t dir` with every operand a source, else the last operand. */
function copyOf(args: string[], slashIsContents = false): TreeCopy | null {
  const names = operands(args);
  const target = optionValue(args, "-t", "--target-directory");
  const to = target ?? names.at(-1) ?? null;
  if (to === null) return null;
  const sources = target === null ? names.slice(0, -1) : names;
  return { to, sources, slashIsContents, opaque: false };
}

const extracts = (args: string[]) =>
  /x/.test(args[0] && !args[0].startsWith("-") ? args[0] : "") ||
  shortFlags(args, /x/) ||
  args.some((word) => /^--(?:extract|get)$/.test(word));

const archive = (to: string): TreeCopy => ({
  to,
  sources: [],
  slashIsContents: false,
  opaque: true,
});

type Destination = (args: string[], cwd: string) => TreeCopy | null;

/**
 * What a command copies as a tree, or null when it copies none: a
 * recursive `cp`, an `mv`, `install` or `ditto`, a recursive `rsync` to
 * this machine, and what `tar -x` or `unzip` extract into.
 */
const TREE_COPIES = new Map<string, Destination>([
  ["cp", (args) => (recursive(args, /[rRa]/) ? copyOf(args) : null)],
  ["mv", (args) => copyOf(args)],
  ["install", (args) => copyOf(args)],
  // ditto copies a folder's contents.
  ["ditto", (args) => copyOf(args, true)],
  [
    "rsync",
    (args) => {
      const copy = recursive(args, /[ra]/) ? copyOf(args, true) : null;
      // A remote destination (`host:path`) isn't this machine's.
      return copy && /^[^/]*:/.test(copy.to) ? null : copy;
    },
  ],
  [
    "tar",
    (args, cwd) =>
      extracts(args)
        ? archive(optionValue(args, "-C", "--directory") ?? cwd)
        : null,
  ],
  ["unzip", (args, cwd) => archive(optionValue(args, "-d", null) ?? cwd)],
]);

function treeCopy(words: string[], cwd: string): TreeCopy | null {
  const program = (words[0] ?? "").split("/").pop() ?? "";
  return TREE_COPIES.get(program)?.(words.slice(1), cwd) ?? null;
}

/** The names entries take in a folder, or null when it can't be read. */
function entriesOf(folder: string): string[] | null {
  try {
    return readdirSync(folder);
  } catch {
    return null;
  }
}

/**
 * The names a source lands under in the destination, or null when they
 * can't be told: its own name, or with `SRC/.` (`SRC/` for rsync) the
 * names in it, read on disk; a wildcard lands as what it matches.
 */
function landingNames(source: string, cwd: string, copy: TreeCopy) {
  const contents =
    /(?:^|\/)\.$/.test(source) ||
    (copy.slashIsContents && source.endsWith("/"));
  if (contents) return entriesOf(wordPath(source, cwd));
  if (GLOB.test(source)) {
    const parts = wildcardParts(source, cwd);
    const found = parts ? expandWildcard(parts.folder, parts.rest) : null;
    return found && found.map((path) => basename(path));
  }
  return [basename(source.replace(/\/+$/, "")) || source];
}

/**
 * Whether a tree copy could create or overwrite a protected root:
 * into a root, always; into a folder holding one, when a name it lands
 * under is the name the root has there, or when that can't be told (an
 * archive, an unreadable source).
 */
function copiesOntoRoot(copy: TreeCopy, cwd: string, roots: string[]) {
  const to = wordPath(copy.to, cwd);
  if (roots.some((root) => isWithin(to, root))) return true;
  const held = roots
    .filter((root) => isWithin(root, to))
    .map((root) => relative(to, root).split(sep)[0]!.toLowerCase());
  if (held.length === 0) return false;
  if (copy.opaque) return true;
  return copy.sources.some((source) => {
    const names = landingNames(source, cwd, copy);
    return (
      names === null || names.some((name) => held.includes(name.toLowerCase()))
    );
  });
}

/** The targets a link command points at, as written: all but the link's own name. */
function linkTargets(words: string[], cwd: string) {
  const program = (words[0] ?? "").split("/").pop() ?? "";
  const names = operands(words.slice(1));
  const targets = names.length > 1 ? names.slice(0, -1) : names;
  const link = names.length > 1 ? wordPath(names.at(-1)!, cwd) : cwd;
  // A symbolic link's target is read from the link's folder, or from inside
  // it when the name is an existing folder; a hard link's from here.
  const bases = program === "link" ? [cwd] : [cwd, dirname(link), link];
  return targets.flatMap((target) =>
    bases.map((base) => ({ target, path: wordPath(target, base) })),
  );
}

/** Whether a path is a root, inside one, or a folder holding one. */
const nearRoot = (path: string, roots: string[]) =>
  roots.some((root) => isWithin(path, root) || isWithin(root, path));

/**
 * What a line writes onto the protected roots by other means than naming
 * them: a link pointing at a root or above one, and a tree copy,
 * move, sync or extraction into a root or a folder holding one. A tree
 * copy into such a folder after another part of the line is refused
 * whatever its sources: an earlier part can change them before it runs,
 * so what is on disk now proves nothing.
 */
export function writesOntoRoot(command: string, cwd: string, roots: string[]) {
  let later = false;
  for (const words of programWords(command)) {
    if (makesLink(words))
      for (const { target, path } of linkTargets(words, cwd))
        if (nearRoot(path, roots)) return target;
    const copy = treeCopy(words, cwd);
    if (copy && later && nearRoot(wordPath(copy.to, cwd), roots))
      return copy.to;
    if (copy && copiesOntoRoot(copy, cwd, roots)) return copy.to;
    later = true;
  }
  return null;
}
