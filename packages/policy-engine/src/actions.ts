import {
  classifyArguments,
  classifyCommand,
  type CommandShape,
} from "./commands.ts";
import { fingerprint } from "./protocol.ts";
import { agentName } from "./names.ts";
import {
  bounded,
  MAX_INLINE_INPUT,
  redact,
  redactCommand,
  redactJson,
} from "./redact.ts";
import { globCouldReachSecret } from "./secrets.ts";
import {
  containsHome,
  fullPath,
  insideAll,
  insideCwd,
  partsOf,
} from "./paths.ts";

export { reachesSecret } from "./secrets.ts";
// Part of this module's public API since 0.1.0.
export { redact } from "./redact.ts";
import type { ActionDescriptor, JsonValue } from "./protocol.ts";

const MAX_RESOURCE = 512;
const MAX_COMMAND_ID = MAX_RESOURCE - 42;
export const nonEmptyText = (value: unknown) =>
  typeof value === "string" && value ? value : null;

export type ToolInput = Record<string, unknown>;

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

/** A patch touching more files can't be described, so a person reviews it. */
const MAX_PATCH_FILES = 1000;

/** A file tool: its operation, where its path is, and what it writes. */
type FileTool = {
  operation: string;
  pathField: string;
  content: (input: ToolInput) => unknown;
};

function fileCall(
  { operation, pathField, content }: FileTool,
  input: ToolInput,
  cwd: string | null,
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
      content_sha256: fingerprint(content(input)),
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
function searchCall(
  input: ToolInput,
  cwd: string | null,
  filePattern: unknown,
) {
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
      // A wildcard such as .env* can pick out a secret without naming it, and a
      // search of the home folder, or above it, reaches every secret there.
      reaches_secrets:
        (glob ? globCouldReachSecret(glob) : false) || containsHome(path),
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
    else if (rest.startsWith("Move to: ")) moves.push(rest.slice(9).trimEnd());
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
function webFetchCall(input: ToolInput): ActionDescriptor | null {
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

function webSearchCall(input: ToolInput): ActionDescriptor | null {
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

/** A tool this module has no shape for: an MCP tool, or Claude Code's own. */
function otherToolCall(
  name: string,
  input: ToolInput,
): ActionDescriptor | null {
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

/**
 * Starting a subagent. The resource is its type, named as runs name agents,
 * so a rule or gate can tell starting `qa` from starting `github`. Claude Code
 * starts a general-purpose agent when no type is given.
 */
function subagentCall(input: ToolInput): ActionDescriptor {
  const name = agentName(
    nonEmptyText(input.subagent_type) ?? "general-purpose",
  );
  return {
    tool: "claude-code",
    operation: "agent",
    resource: { kind: "agent", id: name },
    params: { subagent_type: name, input_sha256: fingerprint(input) },
  };
}

const whatIsWritten = (input: ToolInput) => input.content;
const wholeInput = (input: ToolInput) => input;

type Describe = (
  input: ToolInput,
  cwd: string | null,
  name: string,
) => ActionDescriptor | null;

// A Map, so a tool named like an Object property finds nothing.
const describers = new Map<string, Describe>([
  ["Bash", (input, _cwd, name) => shellCall(name, input)],
  ["Agent", (input) => subagentCall(input)],
  // Claude Code's earlier name for Agent, with the same subagent_type.
  ["Task", (input) => subagentCall(input)],
  ["PowerShell", (input, _cwd, name) => shellCall(name, input)],
  [
    "Write",
    (input, cwd) =>
      fileCall(
        {
          operation: "file.write",
          pathField: "file_path",
          content: whatIsWritten,
        },
        input,
        cwd,
      ),
  ],
  [
    "Edit",
    (input, cwd) =>
      fileCall(
        { operation: "file.edit", pathField: "file_path", content: wholeInput },
        input,
        cwd,
      ),
  ],
  [
    "MultiEdit",
    (input, cwd) =>
      fileCall(
        { operation: "file.edit", pathField: "file_path", content: wholeInput },
        input,
        cwd,
      ),
  ],
  [
    "Read",
    (input, cwd) =>
      fileCall(
        { operation: "file.read", pathField: "file_path", content: wholeInput },
        input,
        cwd,
      ),
  ],
  [
    "NotebookEdit",
    (input, cwd) =>
      fileCall(
        {
          operation: "notebook.edit",
          pathField: "notebook_path",
          content: wholeInput,
        },
        input,
        cwd,
      ),
  ],
  ["Grep", (input, cwd) => searchCall(input, cwd, input.glob)],
  ["Glob", (input, cwd) => searchCall(input, cwd, input.pattern)],
  ["apply_patch", (input, cwd) => patchCall(input, cwd)],
  ["WebFetch", (input) => webFetchCall(input)],
  ["WebSearch", (input) => webSearchCall(input)],
]);

/** Null means the call cannot be described reliably, so it is blocked. */
export function describeToolCall(
  name: string,
  input: ToolInput,
  cwd: string | null = null,
): ActionDescriptor | null {
  const describe = describers.get(name);
  const described = describe
    ? describe(input, cwd, name)
    : otherToolCall(name, input);
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
