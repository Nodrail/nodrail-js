import { globCouldReachSecret, isSecretName } from "./secrets.ts";

/** How a shell command is judged. No Node APIs, so it runs anywhere. */
export type CommandShape = {
  operation: "command.run" | "command.compound";
  text: string;
  /** Set when a compound is only simple commands chained, to be judged one by one. */
  parts?: string[];
  /** What ran it unchanged, such as `rtk` or `nohup`: rules judge `text`. */
  via?: string;
};

// Programs that run the command after them unchanged, read in shapes known
// exactly, so a rule on `kubectl` also judges `rtk kubectl` and
// `nohup kubectl`. Any other shape stays a whole the rules can't split.

/** rtk subcommands that run the program of the same name with the same arguments. */
const rtkPrograms = new Set(
  `git gh glab aws psql pnpm docker kubectl oc curl wget cargo go deno bun bunx
   npx dotnet tsc jest vitest playwright prisma prettier ruff mypy pytest rspec
   rubocop rake ls tree find grep rg ast-grep wc gt`.split(/\s+/),
);
/** rtk subcommands that run the command after them. */
const rtkRunners = new Set([
  "bypass",
  "proxy",
  "err",
  "test",
  "summary",
  "run",
]);
/** rtk's own commands, which run nothing else: judged as `rtk <command>`. */
const rtkOwn = new Set(
  `gain discover session cc-economics hook-audit methods pipeline plugins tasks
   telemetry config init trust untrust verify read smart json deps env log learn
   recall rewrite help -h --help -V --version`.split(/\s+/),
);

type Unwrapped = { words: string[]; via: string[] };

/** rtk [-v|--skip-env] <subcommand> …: the command it runs, or null if unknown. */
function unwrapRtk(words: string[]): Unwrapped | null {
  let at = 1;
  while (/^(?:-v{1,3}|--verbose|--skip-env)$/.test(words[at] ?? "")) at += 1;
  const sub = words[at] ?? "";
  if (rtkOwn.has(sub)) return { words, via: [] };
  if (rtkPrograms.has(sub))
    return { words: words.slice(at), via: words.slice(0, at) };
  if (!rtkRunners.has(sub)) return null;
  at += 1;
  // -c, --command and --shell take a string a shell reads.
  while (words[at] === "--skip-env") at += 1;
  if (words[at]?.startsWith("-")) return null;
  return { words: words.slice(at), via: words.slice(0, at) };
}

/** How many words a known prefix takes before its command, or null. */
function prefixLength(words: string[]): number | null {
  const [program, ...args] = words;
  const flags = (pattern: RegExp) => {
    let at = 0;
    while (pattern.test(args[at] ?? "")) at += 1;
    return at + 1;
  };
  switch (program) {
    case "nohup":
      return 1;
    case "time":
      return flags(/^-p$/);
    case "caffeinate":
      return flags(/^-[dimsu]+$/);
    case "nice":
      if (/^-\d{1,2}$/.test(args[0] ?? "")) return 2;
      return args[0] === "-n" && /^-?\d{1,2}$/.test(args[1] ?? "") ? 3 : 1;
    case "timeout": {
      const at = flags(/^--(?:preserve-status|foreground)$/) - 1;
      return /^\d{1,6}(?:\.\d{1,3})?[smhd]?$/.test(args[at] ?? "")
        ? at + 2
        : null;
    }
    default:
      return 0;
  }
}

/** Wrappers read in a row, such as `rtk proxy nohup …`; more is judged whole. */
const MAX_WRAPPERS = 4;

/**
 * The command a line really runs, with the wrappers in front of it, or null
 * for a wrapper used in a shape not known here. Rules judge `words`.
 */
function unwrap(words: string[]): Unwrapped | null {
  let rest = words;
  const via: string[] = [];
  // One pass per wrapper, and one more to find the command they run.
  for (let depth = 0; depth <= MAX_WRAPPERS; depth += 1) {
    let next: Unwrapped | null;
    if (rest[0] === "rtk") next = unwrapRtk(rest);
    else {
      const taken = prefixLength(rest);
      if (taken === null) return null;
      next = { words: rest.slice(taken), via: rest.slice(0, taken) };
    }
    if (!next) return null;
    if (!next.via.length) return { words: rest, via };
    // An option the prefix doesn't take is not a program.
    if (!next.words.length || next.words[0]?.startsWith("-")) return null;
    via.push(...next.via);
    rest = next.words;
  }
  return null;
}

/**
 * Anything that chains, substitutes, redirects or escapes cannot be judged by
 * how it starts, so a rule for "git status" must not match "git status; rm -rf /".
 */
const shellSyntax = /[;&|`$<>(){}\n\r\\]/;

/** Shells only split on space and tab, so anything else changes the words. */
const unusualWhitespace = /[^\S \t]/;

const assignment = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/;

/** A program name a shell would still have to work out. */
const computedProgram = /^=|[*?[\]]/;

/**
 * Programs that run other programs or code from their arguments. Not
 * exhaustive: an allow on a program trusts it with whatever it is given.
 */
const wrappers = new Set(
  `sudo doas su env xargs eval exec command builtin source . time nohup nice
   ionice timeout watch setsid stdbuf chroot flock parallel script taskset
   unshare nsenter caffeinate arch open at batch strace ltrace gdb lldb expect
   tmux screen busybox sh bash zsh dash fish ksh pwsh powershell cmd awk gawk
   mawk nawk sed node deno bun tsx ts-node npx pnpx bunx perl ruby php lua
   tclsh rscript osascript pypy pypy3 vi vim nvim emacs ssh scp sftp docker
   podman kubectl pkexec runuser sg`.split(/\s+/),
);
const python = /^python[0-9.]*$/;

/** Arguments that run code or write files, on whichever program takes them. */
const riskyArgument =
  /^(?:-c|-e|-exec|-execdir|-ok|-okdir|-delete|-fprint.*|-fls|--eval|--expression(?:=.*)?|--(?:exec|output|rsh|to-command|checkpoint-action|use-compress-program|upload-pack|receive-pack|open-files-in-pager|pre|config-env|compress-program|unzip-command|pager)(?:=.*)?)$/;

const packageManagerFlags =
  /^--(?:script-shell|shell|config\..+|prefix|dir|userconfig|globalconfig|node-options|call|workspace-root)(?:=.*)?$/;

// Maps, not objects: a program called __proto__ or constructor must find nothing.
const riskyByProgram = new Map<string, RegExp>(
  Object.entries({
    // -u is clone's --upload-pack; --config and --template can set a command or
    // install hooks that run on the next git command.
    git: /^(?:-x|-O.*|-u.*|--config(?:=.*)?|--template(?:=.*)?)$/,
    zip: /^(?:-TT.*|--unzip-command(?:=.*)?)$/,
    man: /^(?:-P.*|--pager(?:=.*)?|-H.*|--html(?:=.*)?)$/,
    tar: /^(?:-I.*|-[a-zA-Z]*I)$/,
    rsync: /^-e.*$/,
    curl: /^(?:-[oOKTdF].*|--(?:output|remote-name|config|upload-file|data.*|form.*|json)(?:=.*)?)$/,
    wget: /^(?:-[oO].*|--(?:output-document|output-file|post-file)(?:=.*)?)$/,
    dd: /^of=/,
    make: /^(?:-[fC].*|--(?:file|makefile|directory|eval)(?:=.*)?)$/,
    // Settings that swap the shell scripts run in, or where config comes from.
    npm: packageManagerFlags,
    pnpm: packageManagerFlags,
    yarn: packageManagerFlags,
  }),
);

const riskySubcommands = new Map<string, RegExp>(
  Object.entries({
    git: /^(?:bisect|submodule|filter-branch|difftool|mergetool|config|alias|credential|hook)$/,
    npm: /^(?:exec|x)$/,
    pnpm: /^(?:exec|dlx)$/,
    yarn: /^(?:exec|dlx)$/,
  }),
);

/**
 * Whether an argument points at a place credentials live, such as .env,
 * ~/.ssh/id_rsa, HEAD:.env, './.ENV' or '.e*'. An allowed prefix like `git log`
 * must not stretch to `git log -p -- .env`.
 */
const namesASecret = (words: string[]) =>
  words.slice(1).some((word) => word.split(/[:=]/).some(fragmentReachesSecret));

/** A literal name, or a wildcard such as '.e*' or .en? that could match one. */
function fragmentReachesSecret(fragment: string) {
  if (fragment.length <= 256) return globCouldReachSecret(fragment);
  // Too long to match patterns against quickly: its plain names still count.
  return fragment.split(/[\\/]/).some(isSecretName);
}

/** An assignment in front, or a program that runs other code. */
const hidesItsProgram = (words: string[]) =>
  assignment.test(words[0] ?? "") || runsAnotherCommand(words);

function runsAnotherCommand(words: string[]) {
  if (namesASecret(words)) return true;
  const first = words[0] ?? "";
  if (computedProgram.test(first)) return true;
  // Case-insensitive disks run BASH as bash.
  const program = (first.split("/").pop() ?? "").toLowerCase();
  if (wrappers.has(program) || python.test(program)) return true;
  const args = words.slice(1);
  // Options before a git subcommand hide which subcommand it is.
  if (program === "git" && args[0]?.startsWith("-")) return true;
  if (riskySubcommands.get(program)?.test(args[0] ?? "")) return true;
  const specific = riskyByProgram.get(program);
  return args.some(
    (word) => riskyArgument.test(word) || specific?.test(word) === true,
  );
}

/**
 * Splits like a shell does, or null if the quoting never closes. `breaks`
 * are the characters that end a word outside quotes.
 */
function splitWords(line: string, breaks = " \t") {
  const words: string[] = [];
  let word = "";
  let started = false;
  let quote: string | null = null;
  for (const char of line) {
    if (quote) {
      if (char === quote) quote = null;
      else word += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (breaks.includes(char)) {
      if (started) words.push(word);
      word = "";
      started = false;
    } else {
      word += char;
      started = true;
    }
  }
  if (quote) return null;
  if (started) words.push(word);
  return words;
}

/** One spelling per command, so `g"i"t  push` is `git push` to every rule. */
const render = (words: string[]) =>
  words
    .map((word) => (/^[^\s"']+$/.test(word) ? word : JSON.stringify(word)))
    .join(" ");

const MAX_CHAIN_PARTS = 20;

/** Splits on && || ; | and newlines outside quotes, or null if it can't. */
/**
 * How many characters the chain separator at `index` takes: 1 for ; | or a
 * newline, 2 for && || or |&. Null for one a shell would read differently: a
 * lone & runs in the background, and ;; only means something inside case.
 */
function separatorLength(text: string, index: number) {
  const char = text[index] ?? "";
  const doubled = text[index + 1] === char;
  if (char === "&" && !doubled) return null;
  if (doubled && (char === ";" || char === "\n")) return null;
  return doubled ? 2 : 1;
}

function splitChain(text: string) {
  const parts: string[] = [];
  let part = "";
  let quote: string | null = null;
  // By code unit: every separator is ASCII, and the rest is copied as it is.
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") quote = char;
    if (quote || !";&|\n".includes(char)) {
      part += char;
      continue;
    }
    const length = separatorLength(text, index);
    if (length === null) return null;
    index += length - 1;
    parts.push(part);
    part = "";
  }
  if (quote) return null;
  parts.push(part);
  if (parts.at(-1)?.trim() === "") parts.pop();
  return parts;
}

function judgeSimple(text: string): CommandShape {
  const compound = { operation: "command.compound", text } as const;
  if (shellSyntax.test(text) || unusualWhitespace.test(text)) return compound;
  const split = splitWords(text);
  if (!split?.length || assignment.test(split[0] ?? "")) return compound;
  const inner = unwrap(split);
  if (!inner || hidesItsProgram(inner.words)) return compound;
  return simpleShape(inner);
}

const simpleShape = ({ words, via }: Unwrapped): CommandShape => ({
  operation: "command.run",
  text: render(words),
  ...(via.length ? { via: render(via) } : {}),
});

/** The simple commands in a chain, or null if any part isn't simple. */
function chainParts(text: string) {
  const split = splitChain(text);
  if (!split || split.length < 2 || split.length > MAX_CHAIN_PARTS) return null;
  const shapes = split.map((part) =>
    judgeSimple(part.replace(/^[ \t]+|[ \t]+$/g, "")),
  );
  return shapes.every((shape) => shape.operation === "command.run")
    ? shapes.map((shape) => shape.text)
    : null;
}

const isShellSpace = (char: string | undefined) =>
  char === " " || char === "\t" || char === "\r" || char === "\n";

/**
 * Not trim(): that would also remove characters a shell keeps in the name. And
 * not a regular expression: one anchored at both ends takes quadratic time on a
 * long run of spaces, and an agent writes the command.
 */
function trimShellSpace(line: string) {
  let start = 0;
  let end = line.length;
  while (start < end && isShellSpace(line[start])) start += 1;
  while (end > start && isShellSpace(line[end - 1])) end -= 1;
  return line.slice(start, end);
}

/**
 * The words of one plain command, as a shell would split them: null for a
 * chain, shell syntax, an assignment in front, or quoting that never closes.
 * Unlike classifyCommand, a program that can run others is still returned:
 * the caller decides which exact shapes it reads.
 */
export function plainWords(line: string): string[] | null {
  const text = trimShellSpace(line);
  if (
    chainParts(text) ||
    shellSyntax.test(text) ||
    unusualWhitespace.test(text)
  )
    return null;
  const words = splitWords(text);
  if (!words?.length || assignment.test(words[0] ?? "")) return null;
  const inner = unwrap(words);
  if (!inner || assignment.test(inner.words[0] ?? "")) return null;
  return inner.words;
}

/**
 * Every word of a line as the shell would hand it to a program, quotes
 * joined (`".git/nod""rail"` is `.git/nodrail`), with chains, pipes,
 * redirects and subshells as breaks between words. Null when the quoting
 * never closes. For finding the paths a line names, not for judging it.
 */
export const shellWords = (line: string) => splitWords(line, " \t\r\n;&|<>()`");

/**
 * Each command of a line as its program sees it: the chain's parts, quotes
 * joined, redirects as breaks, wrappers (`nohup`, `rtk proxy`…) taken off.
 * For finding what a line writes, not for judging it.
 */
export function programWords(line: string): string[][] {
  const text = trimShellSpace(line);
  // A line the chain splitter refuses (a lone `&`, `;;`) is cut on every
  // separator: more parts can only make a later part look later.
  return (splitChain(text) ?? text.split(/[;&|\n]+/)).flatMap((part) => {
    // Quoting cut by that split is read as plain words.
    const words = shellWords(part) ?? part.split(/[\s'"]+/).filter(Boolean);
    if (!words.length) return [];
    return [unwrap(words)?.words ?? words];
  });
}

/** Short options run together, `-rs`, or long ones, as one list of letters or names. */
const hasOption = (args: string[], letters: RegExp, long: string[]) =>
  args.some(
    (word) =>
      (/^-[^-]/.test(word) && letters.test(word.slice(1))) ||
      long.some((name) => word === name || word.startsWith(`${name}=`)),
  );

/** Whether a command makes a link: `ln`, `link`, `cp -s`. */
export function makesLink(words: string[]) {
  const program = (words[0] ?? "").split("/").pop() ?? "";
  if (program === "ln" || program === "link") return true;
  return (
    program === "cp" && hasOption(words.slice(1), /s/, ["--symbolic-link"])
  );
}

/** Judges a line a shell would run. */
export function classifyCommand(line: string): CommandShape {
  const text = trimShellSpace(line);
  const parts = chainParts(text);
  // A link made in one part and used in the next doesn't exist yet when the
  // line is judged, so such a line is judged whole (R376).
  if (parts && programWords(text).some(makesLink))
    return { operation: "command.compound", text };
  return parts
    ? { operation: "command.compound", text, parts }
    : judgeSimple(text);
}

/** Judges arguments run directly, where nothing is shell syntax. */
export function classifyArguments(words: string[]): CommandShape {
  const inner = unwrap(words);
  if (inner && !runsAnotherCommand(inner.words)) return simpleShape(inner);
  return { operation: "command.compound", text: render(words) };
}
