import { fileCall, searchCall, wholeInput } from "./actions.ts";
import { plainWords } from "./commands.ts";
import type { ActionDescriptor } from "./protocol.ts";

// The shell commands that only read a file or search a folder, in shapes
// known exactly, so they can be judged as the file reads and searches they
// are. Codex reads files through its shell; this lets the same file rules,
// secret ones included, decide them on both hosts. Several files named one
// by one are several reads, each judged. Anything else, an unknown flag, a
// recursive grep, stays a shell command.

/** What a command reads, or where it searches, with paths as written. */
export type ShellRead =
  | { kind: "read"; paths: string[] }
  | {
      kind: "search";
      path: string | null;
      glob: string | null;
      pattern: string | null;
    };

const number = /^\d{1,9}$/;

/** Most files one command is read as: more stays a shell command. */
const MAX_FILES = 20;

/** Flags then one or more paths; `flag` says whether a word is a flag it takes. */
function somePaths(
  args: string[],
  flag: (word: string, next: string | undefined) => number,
): string[] | null {
  let index = 0;
  while (
    index < args.length &&
    args[index]!.startsWith("-") &&
    args[index] !== "-"
  ) {
    const taken = flag(args[index]!, args[index + 1]);
    if (taken === 0) return null;
    index += taken;
  }
  const rest = args.slice(index);
  return rest.length >= 1 &&
    rest.length <= MAX_FILES &&
    rest.every((word) => !word.startsWith("-"))
    ? rest
    : null;
}

const none = () => 0;
/** head and tail: -n N, -nN, -N or -c N. Never tail -f. */
const lines = (word: string, next: string | undefined) =>
  (word === "-n" || word === "-c") && next !== undefined && number.test(next)
    ? 2
    : /^-[nc]?\d{1,9}$/.test(word)
      ? 1
      : 0;

const readers: Record<string, (args: string[]) => string[] | null> = {
  cat: (args) => somePaths(args, none),
  head: (args) => somePaths(args, lines),
  tail: (args) => somePaths(args, lines),
  nl: (args) => somePaths(args, (word) => (word === "-ba" ? 1 : 0)),
  wc: (args) => somePaths(args, (word) => (/^-[lcwm]+$/.test(word) ? 1 : 0)),
  // Only printing lines: sed's other commands run programs or write files.
  sed: (args) =>
    args.length === 3 &&
    args[0] === "-n" &&
    /^\d{1,9}(,\d{1,9})?p$/.test(args[1]!)
      ? [args[2]!]
      : null,
  // One file, never -r: a recursive grep reads dotfiles such as .env unnamed.
  grep: (args) => {
    const words = args.filter((word) => !/^-[nilcwFEHhsv]+$/.test(word));
    return words.length === 2 && !words.some((word) => word.startsWith("-"))
      ? [words[1]!]
      : null;
  },
};

/** rg flags that only shape the output. Not --hidden, -u, --no-ignore: those reach dotfiles. */
const rgFlags =
  /^(?:-[nilcwFSo]+|--(?:files|line-number|ignore-case|smart-case|files-with-matches|count|word-regexp|fixed-strings|no-heading|heading|color=never|only-matching))$/;
const rgValued =
  /^-[ABCm]$|^--(?:context|after-context|before-context|max-count)$/;

type RgWords = { files: boolean; glob: string | null; plain: string[] };

/** How many words one rg option takes, or 0 when it isn't one we know. */
function rgOption(words: RgWords, word: string, next: string | undefined) {
  if (rgFlags.test(word)) {
    if (word === "--files") words.files = true;
    return 1;
  }
  if (rgValued.test(word) && next !== undefined && number.test(next)) return 2;
  if (words.glob !== null) return 0;
  if ((word === "-g" || word === "--glob") && next !== undefined) {
    words.glob = next;
    return 2;
  }
  if (word.startsWith("--glob=")) {
    words.glob = word.slice("--glob=".length);
    return 1;
  }
  return 0;
}

function ripgrep(args: string[]): ShellRead | null {
  const words: RgWords = { files: false, glob: null, plain: [] };
  for (let index = 0; index < args.length;) {
    const word = args[index]!;
    if (!word.startsWith("-")) {
      words.plain.push(word);
      index += 1;
      continue;
    }
    const taken = rgOption(words, word, args[index + 1]);
    if (taken === 0) return null;
    index += taken;
  }
  // An excluding glob, !x, can't be followed to what it leaves: refused.
  if (words.glob?.startsWith("!")) return null;
  const [pattern, path, ...more] = words.files
    ? [null, ...words.plain]
    : words.plain;
  if (more.length > 0 || (!words.files && pattern === undefined)) return null;
  return {
    kind: "search",
    path: path ?? null,
    glob: words.glob,
    pattern: pattern ?? null,
  };
}

/** ls with letters only: it names files, it reads none. */
function list(args: string[]): ShellRead | null {
  const paths = args.filter((word) => !/^-[a-zA-Z1]+$/.test(word));
  if (paths.length > 1 || paths.some((word) => word.startsWith("-")))
    return null;
  return { kind: "search", path: paths[0] ?? null, glob: null, pattern: null };
}

/** What a plain command's words read or search, or null for anything else. */
function shellRead(words: string[]): ShellRead | null {
  const [program, ...args] = words;
  if (program === "rg") return ripgrep(args);
  if (program === "ls") return list(args);
  const reader = program === undefined ? undefined : readers[program];
  const paths = reader?.(args);
  return paths ? { kind: "read", paths } : null;
}

/** A shell expands these before the program sees them: the word isn't a path. */
const expands = /[*?[\]{}]|^~/;

/**
 * Whether the words are what the program gets. A path with a wildcard or a
 * leading ~ is expanded by the shell first, so it may name other files, .env
 * included. An rg pattern or glob may hold wildcards only where quoted.
 */
function literal(read: ShellRead, command: string) {
  const quoted = (word: string) =>
    command.includes(`'${word}'`) || command.includes(`"${word}"`);
  if (read.kind === "read")
    return read.paths.every((path) => !expands.test(path));
  if (read.path !== null && expands.test(read.path)) return false;
  // rg's own pattern and glob, unlike a path, may hold wildcards: quoted.
  return [read.pattern, read.glob].every(
    (word) => word === null || !expands.test(word) || quoted(word),
  );
}

/**
 * The file reads or search a shell command is, in a shape known exactly,
 * or null. The hook judges it this way too, beside the command itself, so the
 * file rules decide a `cat` as they decide the Read tool, secrets included.
 */
export function shellReadAction(
  command: string,
  cwd: string | null,
): ActionDescriptor[] | null {
  const words = plainWords(command);
  const read = words ? shellRead(words) : null;
  if (!read || !literal(read, command)) return null;
  if (read.kind === "read") {
    const actions = read.paths.map((path) =>
      fileCall(
        { operation: "file.read", pathField: "file_path", content: wholeInput },
        { file_path: path, command },
        cwd,
      ),
    );
    // A path that can't be described makes the command a command again.
    return actions.every((action) => action !== null)
      ? (actions as ActionDescriptor[])
      : null;
  }
  const search = searchCall(
    { path: read.path, pattern: read.pattern, command },
    cwd,
    read.glob,
  );
  return search ? [search] : null;
}
