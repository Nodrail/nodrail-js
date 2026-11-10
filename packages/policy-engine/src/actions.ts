import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import {
  classifyArguments,
  classifyCommand,
  type CommandShape,
} from "./commands.ts";
import { fingerprint } from "./protocol.ts";
import { globCouldReachSecret, nameForms } from "./secrets.ts";
import type { ActionDescriptor, JsonValue } from "./protocol.ts";

const MAX_RESOURCE = 512;
const MAX_INLINE_INPUT = 16 * 1024;
const MAX_COMMAND_ID = MAX_RESOURCE - 42;
export const nonEmptyText = (value: unknown) =>
  typeof value === "string" && value ? value : null;

export type ToolInput = Record<string, unknown>;

const REDACTED = "[redacted]";
const sensitiveWord =
  /token|secret|passw(?:or)?d|pwd|api[_-]?key|credential|authorization/i;

/**
 * A value worth hiding. Something computed in place is code, not a secret, and
 * hiding it would hide what the command does.
 */
const secretValue = `"(?![^"]*[$\`])[^"]*"|'[^']*'|(?![^\\s&;|]*[$\`])[^\\s&;|]+`;

const secretPatterns: [RegExp, string][] = [
  // A whole header value, whatever scheme it uses.
  [
    /\b(authorization|proxy-authorization|cookie|set-cookie|x-api-key)(\s*:\s*)[^'"\n]+/gi,
    `$1$2${REDACTED}`,
  ],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`],
  [/([?&](?:key|sig|signature|auth|code)=)[^&\s'"]+/gi, `$1${REDACTED}`],
  [/(\s-u\s+)[^\s:]+:\S+/g, `$1${REDACTED}`],
  [/\b(mysql|mysqldump|mariadb)\b([^|;&\n]*\s-p)[^\s]+/g, `$1$2${REDACTED}`],
  [/(\/\/)[^/\s:@]+:[^/\s@]+@/g, `$1${REDACTED}@`],
  // Known token shapes, found anywhere: a shell joins 0'ghp_…'_ into one word,
  // and the token must still be found inside it.
  [
    /(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+)/g,
    REDACTED,
  ],
  // sk- is common inside ordinary words (task-…), so it needs no letter or
  // digit just before it.
  [/(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/g, REDACTED],
];

const nameChars = /[A-Za-z0-9_-]+/g;
const assignmentAt = /=|:\s*/y;
const spaceAt = /\s+/y;
const valueAt = new RegExp(`(?:${secretValue})`, "y");

/**
 * NAME=value, name: value, and --name value, found word by word. A pattern
 * that searched for the name anywhere took quadratic time on a long word, and
 * an agent writes the text.
 */
function redactNamedValues(text: string) {
  let shown = "";
  let copied = 0;
  for (const word of text.matchAll(nameChars)) {
    const start = word.index;
    if (start < copied || !sensitiveWord.test(word[0])) continue;
    let at = start + word[0].length;
    assignmentAt.lastIndex = at;
    const assignment = assignmentAt.exec(text);
    if (assignment) at += assignment[0].length;
    else {
      // A value after a space only counts when the name is really a flag, so a
      // path like ./tokens can't hide the argument that follows it.
      const isFlag =
        word[0].startsWith("-") && (start === 0 || /\s/.test(text[start - 1] ?? ""));
      spaceAt.lastIndex = at;
      const space = isFlag ? spaceAt.exec(text) : null;
      if (!space) continue;
      at += space[0].length;
    }
    valueAt.lastIndex = at;
    const value = valueAt.exec(text);
    if (!value) continue;
    shown += text.slice(copied, at) + REDACTED;
    copied = at + value[0].length;
  }
  return shown + text.slice(copied);
}

/** Text longer than this is shortened before it is read, so reading stays fast. */
const MAX_REDACTED = MAX_INLINE_INPUT;

/**
 * At most MAX_REDACTED characters, cut at a space where there is one, so the
 * end of a secret can't survive as a fragment too short to recognise.
 */
function bounded(value: string) {
  if (value.length <= MAX_REDACTED) return value;
  const head = value.slice(0, MAX_REDACTED);
  const space = head.search(/\s\S*$/);
  return `${space > 0 ? head.slice(0, space) : ""} … [shortened]`;
}

/**
 * Best effort: it removes what looks like a secret before anything leaves this
 * machine. The fingerprint sent beside it still binds the exact original.
 * Shortening a long value changes it too, so it counts as hidden.
 */
export const redact = (value: string) =>
  secretPatterns.reduce(
    (current, [pattern, replacement]) => current.replace(pattern, replacement),
    redactNamedValues(bounded(value)),
  );

/**
 * Each part of a command on its own, so a hidden header can't swallow what
 * comes after it. Separators inside quotes are part of the value.
 */
function redactCommand(line: string) {
  let shown = "";
  let part = "";
  let quote: string | null = null;
  for (const char of line) {
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") quote = char;
    if (!quote && ";&|\n".includes(char)) {
      shown += redact(part) + char;
      part = "";
    } else part += char;
  }
  return shown + redact(part);
}

/** A key that names a secret, such as api_key or GITHUB_TOKEN. Linear on any key. */
const isSensitiveKey = (key: string) =>
  /^[A-Za-z0-9_-]+$/.test(key) && sensitiveWord.test(key);

function redactJson(value: unknown): JsonValue {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(redactJson);
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        isSensitiveKey(key) ? REDACTED : redactJson(item),
      ]),
    );
  return value as JsonValue;
}

const clip = (value: string, max: number) =>
  value.length <= max ? value : `${value.slice(0, max)}… [shortened]`;

function commandAction(
  shape: CommandShape,
  original: unknown,
  extra: Record<string, JsonValue>,
): ActionDescriptor {
  // Only a bounded prefix is read. Shortened and hidden are told apart, so a
  // reviewer isn't told a secret was removed when the command was just long.
  const visible = bounded(shape.text);
  const shown = redactCommand(visible);
  const hidden = shown !== visible;
  const shortened = shape.text.length > MAX_COMMAND_ID;
  // Rules see less than what will run, so none written for the visible part may
  // cover it, and a rule made from this request can only match this exact call.
  let operation: string = shape.operation;
  if (hidden) operation = "command.redacted";
  else if (shortened) operation = "command.compound";
  const commandSha = fingerprint(original);
  const id = clip(shown, MAX_COMMAND_ID);
  return {
    tool: "shell",
    operation,
    resource: {
      kind: "command",
      id: hidden || shortened ? `${id} #${commandSha.slice(7, 19)}` : id,
    },
    params: {
      // Reviewers read this; the fingerprint binds the exact original.
      command: clip(shown, MAX_INLINE_INPUT),
      command_sha256: commandSha,
      // A hidden part can't be judged by what is visible, so never split one.
      ...(shape.parts && !hidden ? { parts: shape.parts } : {}),
      ...extra,
    },
  };
}

function shellCall(name: string, input: ToolInput): ActionDescriptor | null {
  const command = nonEmptyText(input.command);
  if (!command?.trim()) return null;
  return commandAction(classifyCommand(command), command, {
    shell: name,
    background: input.run_in_background === true,
  });
}

/** For a program started directly, with no shell in between. */
export function describeArguments(words: string[]): ActionDescriptor {
  return commandAction(classifyArguments(words), words, { shell: "none" });
}

/**
 * The real path where it can be known: symlinks followed, and the disk's own
 * casing, so .CLAUDE can't pass for something other than .claude.
 */
function canonicalPath(path: string) {
  const missing: string[] = [];
  let existing = path;
  for (;;) {
    try {
      return join(realpathSync.native(existing), ...missing.reverse());
    } catch {
      const parent = dirname(existing);
      if (parent === existing) return path;
      missing.push(basename(existing));
      existing = parent;
    }
  }
}

/**
 * Lets a rule name one folder or file anywhere in a path. A dot file with a
 * suffix also answers to its base, so .env.staging contains .env.
 */
const partsOf = (path: string) => [
  ...new Set(path.split(/[\\/]/).filter(Boolean).flatMap(nameForms)),
];

/** Longer or deeper paths aren't real, and would only make checking slow. */
const MAX_PATH = 4096;
const MAX_DEPTH = 256;

function fullPath(raw: string, cwd: string | null) {
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
function insideCwd(path: string, cwd: string | null): Record<string, boolean> {
  const root = cwd ? fullPath(cwd, null) : null;
  return root ? { inside_cwd: isWithin(path, root) } : {};
}

function isWithin(path: string, root: string) {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return path === root || path.startsWith(prefix);
}

/** Whether every path is inside the working folder, resolved once. */
function insideAll(paths: string[], cwd: string | null): Record<string, boolean> {
  const root = cwd ? fullPath(cwd, null) : null;
  return root ? { inside_cwd: paths.every((path) => isWithin(path, root)) } : {};
}

/** A patch touching more files can't be described, so a person reviews it. */
const MAX_PATCH_FILES = 1000;

function fileCall(
  operation: string,
  pathField: string,
  input: ToolInput,
  cwd: string | null,
  content: unknown,
): ActionDescriptor | null {
  const raw = nonEmptyText(input[pathField]);
  if (!raw) return null;
  const path = fullPath(raw, cwd);
  if (!path) return null;
  return {
    tool: "files",
    operation,
    resource: { kind: "file", id: path },
    // What is written can hold secrets, so reviewers get its fingerprint.
    params: {
      path,
      path_parts: partsOf(path),
      ...insideCwd(path, cwd),
      content_sha256: fingerprint(content),
    },
  };
}

/** The folders a glob names before its first wildcard. */
function globRoot(pattern: string) {
  const fixed: string[] = [];
  for (const part of pattern.split(/[\\/]/)) {
    if (/[*?[\]{}]/.test(part)) break;
    fixed.push(part);
  }
  return fixed.join("/");
}

/**
 * A search is judged by everywhere it can reach: its folder, and any path its
 * file pattern names, so a pattern like /home/me/.ssh/* or **\/.env can't
 * search where a rule forbids reading.
 */
function searchCall(input: ToolInput, cwd: string | null, filePattern: unknown) {
  const within = nonEmptyText(input.path) ?? cwd;
  const base = within ? fullPath(within, cwd) : null;
  if (!base) return null;
  const glob = nonEmptyText(filePattern);
  const root = glob ? globRoot(glob) : "";
  const path = root ? fullPath(root, base) : base;
  if (!path) return null;
  return {
    tool: "files",
    operation: "file.search",
    resource: { kind: "file", id: path },
    params: {
      path,
      path_parts: [...new Set([...partsOf(path), ...partsOf(glob ?? "")])],
      ...insideCwd(path, cwd),
      // A wildcard such as .env* can pick out a secret without naming it.
      reaches_secrets: glob ? globCouldReachSecret(glob) : false,
      pattern: redact(nonEmptyText(input.pattern) ?? ""),
      input_sha256: fingerprint(input),
    },
  } satisfies ActionDescriptor;
}

/**
 * Rule keys are lowercase. A name that needs changing gets a fingerprint, so
 * "GitHub" and "github", or "a.b" and "a-b", can never share a rule.
 */
function ruleKey(value: string, max: number) {
  // A name already shaped like a tagged one is tagged too, so it can't pose as it.
  const plain = /^[a-z0-9_-]+$/.test(value) && !/-[0-9a-f]{8}$/.test(value);
  if (value.length > 0 && value.length <= max && plain) return value;
  const tag = fingerprint(value).slice("sha256:".length, 15);
  const readable = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .slice(0, max - tag.length - 1);
  return `${readable}-${tag}`;
}

/** Enough for a reviewer to read, with anything that looks secret taken out. */
function inputParams(input: ToolInput) {
  const size = Buffer.byteLength(JSON.stringify(input));
  return {
    ...(size <= MAX_INLINE_INPUT ? { input: redactJson(input) } : {}),
    input_sha256: fingerprint(input),
  };
}

function mcpCall(name: string, input: ToolInput): ActionDescriptor | null {
  const [, server, ...rest] = name.split("__");
  const tool = rest.join("__");
  if (!server || !tool) return null;
  return {
    tool: ruleKey(server, 64),
    operation: ruleKey(tool, 128),
    resource: { kind: "mcp_tool", id: `${server}.${tool}` },
    params: inputParams(input),
  };
}

/** A tool known only by its name, as agent frameworks register them. */
export function describeNamedTool(
  name: string,
  input: ToolInput,
): ActionDescriptor | null {
  if (name.length === 0 || name.length > MAX_RESOURCE) return null;
  return {
    tool: ruleKey(name, 64),
    operation: "call",
    resource: { kind: "tool", id: name },
    params: inputParams(input),
  };
}

const patchOperations: Record<string, string> = {
  Add: "file.write",
  Update: "file.edit",
  Delete: "file.delete",
};

const PATCH_VERBS = ["Add", "Update", "Delete"] as const;

/**
 * The file headers of a patch, read line by line. A regular expression here
 * could take minutes on a crafted line, and an agent writes the patch.
 */
function patchHeaders(patch: string) {
  const changes: { verb: (typeof PATCH_VERBS)[number]; path: string }[] = [];
  const moves: string[] = [];
  for (const line of patch.split(/\r\n|[\n\r\u2028\u2029]/)) {
    if (!line.startsWith("*** ")) continue;
    const rest = line.slice(4);
    const verb = PATCH_VERBS.find((name) => rest.startsWith(`${name} File: `));
    if (verb)
      changes.push({ verb, path: rest.slice(verb.length + 7).trimEnd() });
    else if (rest.startsWith("Move to: "))
      moves.push(rest.slice(9).trimEnd());
  }
  return { changes, moves };
}

/**
 * Codex's apply_patch. One plain change is ruled like the same change from any
 * other agent. Anything larger is its own operation with a resource no path
 * prefix can match, so a rule for one folder can't let a second file through.
 */
function patchCall(
  input: ToolInput,
  cwd: string | null,
): ActionDescriptor | null {
  const patch = nonEmptyText(input.command) ?? nonEmptyText(input.patch);
  if (!patch) return null;
  const { changes, moves } = patchHeaders(patch);
  if (changes.length + moves.length > MAX_PATCH_FILES) return null;
  const paths = [...changes.map((change) => change.path), ...moves].map(
    (raw) => (raw ? fullPath(raw, cwd) : null),
  );
  if (paths.length === 0 || paths.some((path) => !path)) return null;
  const known = paths as string[];
  const content_sha256 = fingerprint(patch);
  const [only] = known;
  const operation = patchOperations[changes[0]?.verb ?? ""];
  if (known.length === 1 && only && operation)
    return {
      tool: "files",
      operation,
      resource: { kind: "file", id: only },
      params: {
        path: only,
        path_parts: partsOf(only),
        ...insideCwd(only, cwd),
        content_sha256,
      },
    };
  return {
    tool: "files",
    operation: "file.patch",
    resource: { kind: "file", id: `patch:${content_sha256}` },
    params: {
      paths: known,
      path_parts: [...new Set(known.flatMap(partsOf))],
      ...insideAll(known, cwd),
      content_sha256,
    },
  };
}

/** Null means the call cannot be described reliably, so it is blocked. */
export function describeToolCall(
  name: string,
  input: ToolInput,
  cwd: string | null = null,
): ActionDescriptor | null {
  const described = ((): ActionDescriptor | null => {
    switch (name) {
      case "Bash":
      case "PowerShell":
        return shellCall(name, input);
      case "Write":
        return fileCall("file.write", "file_path", input, cwd, input.content);
      case "Edit":
      case "MultiEdit":
        return fileCall("file.edit", "file_path", input, cwd, input);
      case "Read":
        return fileCall("file.read", "file_path", input, cwd, input);
      case "Grep":
        return searchCall(input, cwd, input.glob);
      case "Glob":
        return searchCall(input, cwd, input.pattern);
      case "NotebookEdit":
        return fileCall("notebook.edit", "notebook_path", input, cwd, input);
      case "apply_patch":
        return patchCall(input, cwd);
      case "WebFetch": {
        const url = nonEmptyText(input.url);
        if (!url || !URL.canParse(url)) return null;
        // Without user info, so a@evil.net can't pass as a prefix of a.
        const { protocol, host, pathname, search } = new URL(url);
        const normal = `${protocol}//${host}${pathname}${search}`;
        const shown = redact(normal);
        return {
          tool: "web",
          operation: shown === normal ? "fetch" : "fetch.redacted",
          resource: { kind: "url", id: shown },
          params: { url: shown, url_sha256: fingerprint(url) },
        };
      }
      case "WebSearch": {
        const query = nonEmptyText(input.query);
        if (!query) return null;
        const shown = redact(query);
        return {
          tool: "web",
          operation: shown === query ? "search" : "search.redacted",
          resource: { kind: "query", id: shown },
          params: { query: shown, query_sha256: fingerprint(query) },
        };
      }
      default:
        if (name.startsWith("mcp__")) return mcpCall(name, input);
        return {
          tool: "claude-code",
          // Claude Code's own names, which differ by more than their case.
          operation: /^[A-Za-z0-9_-]{1,128}$/.test(name)
            ? name.toLowerCase()
            : ruleKey(name, 128),
          resource: { kind: "tool", id: name },
          params: { input_sha256: fingerprint(input) },
        };
    }
  })();
  return described && described.resource.id.length <= MAX_RESOURCE
    ? described
    : null;
}

export type HookResult = { stdout: string; stderr: string; exitCode: number };

export const allowQuietly: HookResult = { stdout: "", stderr: "", exitCode: 0 };

/** Claude Code's own answers to a PreToolUse hook. */
function hookAnswer(decision: "deny" | "ask", reason: string): HookResult {
  return {
    stdout: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: decision,
        permissionDecisionReason: reason,
      },
    }),
    stderr: "",
    exitCode: 0,
  };
}

export const deny = (reason: string) => hookAnswer("deny", reason);
export const askPerson = (reason: string) => hookAnswer("ask", reason);
