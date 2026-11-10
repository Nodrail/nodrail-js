import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  classifyArguments,
  classifyCommand,
  type CommandShape,
} from "./commands";
import { fingerprint } from "./protocol";
import type { ActionDescriptor, JsonValue } from "./protocol";

const MAX_RESOURCE = 512;
const MAX_INLINE_INPUT = 16 * 1024;
const MAX_COMMAND_ID = MAX_RESOURCE - 42;
export const nonEmptyText = (value: unknown) =>
  typeof value === "string" && value ? value : null;

export type ToolInput = Record<string, unknown>;

const REDACTED = "[redacted]";
const sensitiveName =
  "[A-Za-z0-9_-]*(?:token|secret|passw(?:or)?d|pwd|api[_-]?key|credential|authorization)[A-Za-z0-9_-]*";

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
  // NAME=value and name: value, at any position.
  [
    new RegExp(`(${sensitiveName})(=|:\\s*)(${secretValue})`, "gi"),
    `$1$2${REDACTED}`,
  ],
  // A value after a space only counts when the name is really a flag, so a path
  // like ./tokens can't hide the argument that follows it.
  [
    new RegExp(`(\\s--?${sensitiveName})(\\s+)(${secretValue})`, "gi"),
    `$1$2${REDACTED}`,
  ],
  [/([?&](?:key|sig|signature|auth|code)=)[^&\s'"]+/gi, `$1${REDACTED}`],
  [/(\s-u\s+)[^\s:]+:\S+/g, `$1${REDACTED}`],
  [/\b(mysql|mysqldump|mariadb)\b([^|;&\n]*\s-p)[^\s]+/g, `$1$2${REDACTED}`],
  [/(\/\/)[^/\s:@]+:[^/\s@]+@/g, `$1${REDACTED}@`],
  [
    /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+)\b/g,
    REDACTED,
  ],
];

/**
 * Best effort: it removes what looks like a secret before anything leaves this
 * machine. The fingerprint sent beside it still binds the exact original.
 */
export const redact = (value: string) =>
  secretPatterns.reduce(
    (current, [pattern, replacement]) => current.replace(pattern, replacement),
    value,
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

const sensitiveKey = new RegExp(`^${sensitiveName}$`, "i");

function redactJson(value: unknown): JsonValue {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(redactJson);
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        sensitiveKey.test(key) ? REDACTED : redactJson(item),
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
  const shown = redactCommand(shape.text);
  const hidden = shown !== shape.text;
  const shortened = shown.length > MAX_COMMAND_ID;
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
      return join(realpathSync.native(existing), ...missing);
    } catch {
      const parent = dirname(existing);
      if (parent === existing) return path;
      missing.unshift(basename(existing));
      existing = parent;
    }
  }
}

/** Lets a rule name one folder or file anywhere in a path. */
const partsOf = (path: string) => path.split(/[\\/]/).filter(Boolean);

function fullPath(raw: string, cwd: string | null) {
  const expanded = /^~(?=$|\/)/.test(raw) ? `${homedir()}${raw.slice(1)}` : raw;
  // Resolved, so src/../.claude can't pass as a path inside src/.
  if (!isAbsolute(expanded) && !cwd) return null;
  return canonicalPath(resolve(cwd ?? "/", expanded));
}

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
      content_sha256: fingerprint(content),
    },
  };
}

/** Searches read files too, so they are ruled by where they look. */
function searchCall(input: ToolInput, cwd: string | null) {
  const within = nonEmptyText(input.path) ?? cwd;
  const path = within ? fullPath(within, cwd) : null;
  if (!path) return null;
  return {
    tool: "files",
    operation: "file.search",
    resource: { kind: "file", id: path },
    params: {
      path,
      path_parts: partsOf(path),
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
  const changes = [
    ...patch.matchAll(/^\*\*\* (Add|Update|Delete) File: (.+?)\s*$/gm),
  ];
  const moves = [...patch.matchAll(/^\*\*\* Move to: (.+?)\s*$/gm)];
  const paths = [
    ...changes.map((match) => match[2]),
    ...moves.map((m) => m[1]),
  ].map((raw) => fullPath(raw ?? "", cwd));
  if (paths.length === 0 || paths.some((path) => !path)) return null;
  const known = paths as string[];
  const content_sha256 = fingerprint(patch);
  const [only] = known;
  const operation = patchOperations[changes[0]?.[1] ?? ""];
  if (known.length === 1 && only && operation)
    return {
      tool: "files",
      operation,
      resource: { kind: "file", id: only },
      params: { path: only, path_parts: partsOf(only), content_sha256 },
    };
  return {
    tool: "files",
    operation: "file.patch",
    resource: { kind: "file", id: `patch:${content_sha256}` },
    params: {
      paths: known,
      path_parts: [...new Set(known.flatMap(partsOf))],
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
      case "Glob":
        return searchCall(input, cwd);
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
