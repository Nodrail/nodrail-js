import { isSecretName } from "./secrets.ts";

/** How a shell command is judged. No Node APIs, so it runs anywhere. */
export type CommandShape = {
  operation: "command.run" | "command.compound";
  text: string;
  /** Set when a compound is only simple commands chained, to be judged one by one. */
  parts?: string[];
};

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

// Maps, not objects: a program called __proto__ or constructor must find nothing.
const riskyByProgram = new Map<string, RegExp>(Object.entries({
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
}));

const riskySubcommands = new Map<string, RegExp>(Object.entries({
  git: /^(?:bisect|submodule|filter-branch|difftool|mergetool|config|alias|credential|hook)$/,
  npm: /^(?:exec|x)$/,
  pnpm: /^(?:exec|dlx)$/,
  yarn: /^(?:exec|dlx)$/,
}));

/**
 * Whether an argument points at a place credentials live, such as .env,
 * ~/.ssh/id_rsa or HEAD:.env. An allowed prefix like `git log` must not stretch
 * to `git log -p -- .env`.
 */
const namesASecret = (words: string[]) =>
  words.slice(1).some((word) => word.split(/[\\/:=]/).some(isSecretName));

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

/** Splits like a shell does, or null if the quoting never closes. */
function splitWords(line: string) {
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
    } else if (char === " " || char === "\t") {
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
    const doubled = text[index + 1] === char;
    // A lone & runs in the background, and a shell has no ;; outside case.
    if (char === "&" && !doubled) return null;
    if (doubled && (char === ";" || char === "\n")) return null;
    if (doubled) index += 1;
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
  const words = splitWords(text);
  if (!words?.length) return compound;
  if (assignment.test(words[0] ?? "") || runsAnotherCommand(words))
    return compound;
  return { operation: "command.run", text: render(words) };
}

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

/** Judges a line a shell would run. */
export function classifyCommand(line: string): CommandShape {
  const text = trimShellSpace(line);
  const parts = chainParts(text);
  return parts
    ? { operation: "command.compound", text, parts }
    : judgeSimple(text);
}

/** Judges arguments run directly, where nothing is shell syntax. */
export function classifyArguments(words: string[]): CommandShape {
  return {
    operation: runsAnotherCommand(words) ? "command.compound" : "command.run",
    text: render(words),
  };
}
