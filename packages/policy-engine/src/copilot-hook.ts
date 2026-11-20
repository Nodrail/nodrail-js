// GitHub Copilot CLI's preToolUse hook, read as the Claude Code calls it
// matches, so the same rules, guards and modules judge it.
import { isAbsolute, join } from "node:path";
import type { HookResult } from "./actions.ts";

/**
 * Copilot sends `{ sessionId, cwd, toolCallId, toolName, toolArgs }` and
 * reads `{ permissionDecision, permissionDecisionReason }` back; a hook that
 * fails denies the call (verified live with Copilot CLI 1.0.114). Each call
 * becomes one Claude Code `PreToolUse` event, or one per file for a patch.
 */

type Args = Record<string, unknown>;
type Translated = { tool_name: string; tool_input: Args };

const text = (value: unknown) => (typeof value === "string" ? value : "");

/** Copilot's built-in tools, as the Claude Code tool each one is. */
const builtIns: Record<string, (args: Args) => Translated> = {
  bash: (args) => ({
    tool_name: "Bash",
    tool_input: { command: text(args.command) },
  }),
  view: (args) => ({
    tool_name: "Read",
    tool_input: { file_path: text(args.path) },
  }),
  create: (args) => ({
    tool_name: "Write",
    tool_input: { file_path: text(args.path), content: text(args.file_text) },
  }),
  edit: (args) => ({
    tool_name: "Edit",
    tool_input: {
      file_path: text(args.path),
      old_string: text(args.old_str),
      new_string: text(args.new_str),
    },
  }),
  rg: (args) => ({
    tool_name: "Grep",
    tool_input: { pattern: text(args.pattern), path: text(args.paths) || "." },
  }),
  glob: (args) => ({
    tool_name: "Glob",
    tool_input: { pattern: text(args.pattern), path: text(args.paths) || "." },
  }),
  web_fetch: (args) => ({
    tool_name: "WebFetch",
    tool_input: { url: text(args.url), prompt: "" },
  }),
  web_search: (args) => ({
    tool_name: "WebSearch",
    tool_input: { query: text(args.query) },
  }),
  task: (args) => ({
    tool_name: "Task",
    tool_input: {
      subagent_type: text(args.agent_type) || "general-purpose",
      description: text(args.description),
      prompt: text(args.prompt),
    },
  }),
  update_todo: (args) => ({
    tool_name: "TodoWrite",
    tool_input: { todos: args.todos ?? [] },
  }),
  ask_user: (args) => ({
    tool_name: "AskUserQuestion",
    tool_input: { questions: args.question ?? "" },
  }),
};
builtIns.grep = builtIns.rg!;
builtIns.str_replace = builtIns.edit!;
builtIns.str_replace_editor = builtIns.edit!;
builtIns.read_file = builtIns.view!;
builtIns.shell = builtIns.bash!;
// Copilot runs Claude Code's hooks too, naming its tools as Claude Code's
// but keeping its own arguments (`path`, not `file_path`).
for (const [claude, copilot] of Object.entries({
  Bash: "bash",
  Read: "view",
  Write: "create",
  Edit: "edit",
  Grep: "rg",
  Glob: "glob",
  WebFetch: "web_fetch",
  WebSearch: "web_search",
  Task: "task",
}))
  builtIns[claude] = builtIns[copilot]!;

/** The files a patch adds, changes, moves or deletes, by the patch's own headers. */
export function patchFiles(patch: string) {
  const files: { path: string; adds: boolean }[] = [];
  for (const [, verb, path] of patch.matchAll(
    /^\*\*\* (Add File|Update File|Delete File|Move to): (.+)$/gm,
  ))
    files.push({
      path: path!.trim(),
      adds: verb === "Add File" || verb === "Move to",
    });
  return files;
}

/** `<server>-<tool>`, with the longest server nodrail knows: Claude Code's MCP name. */
function mcpName(name: string, servers: readonly string[]) {
  const server = [...servers]
    .sort((a, b) => b.length - a.length)
    .find(
      (each) => name.startsWith(`${each}-`) && name.length > each.length + 1,
    );
  return server ? `mcp__${server}__${name.slice(server.length + 1)}` : null;
}

function argsOf(raw: unknown): Args | null {
  if (typeof raw === "string")
    try {
      const parsed: unknown = JSON.parse(raw);
      return typeof parsed === "object" && parsed !== null
        ? (parsed as Args)
        : { input: raw };
    } catch {
      return { input: raw };
    }
  return typeof raw === "object" && raw !== null ? (raw as Args) : null;
}

/**
 * Copilot's event as the Claude Code events it is, in order; a reason when
 * it can't be read, which the hook refuses. `servers` are the MCP servers
 * the setup declares, so `support-memory-search_nodes` reads as the
 * `support-memory` server's `search_nodes`.
 */
export function copilotEvents(
  stdin: string,
  servers: readonly string[] = [],
): string[] | string {
  let event: {
    cwd?: unknown;
    toolName?: unknown;
    toolArgs?: unknown;
    sessionId?: unknown;
    toolCallId?: unknown;
  };
  try {
    event = JSON.parse(stdin) as typeof event;
  } catch {
    return "Nodrail: this call could not be read, so it is blocked.";
  }
  const name = text(event.toolName);
  const args = argsOf(event.toolArgs);
  if (!name || args === null)
    return "Nodrail: this call could not be identified, so it is blocked.";
  const cwd = text(event.cwd);
  const shared = {
    hook_event_name: "PreToolUse",
    cwd,
    session_id: event.sessionId,
    tool_use_id: event.toolCallId,
  };
  const as = (translated: Translated) =>
    JSON.stringify({ ...shared, ...translated });
  if (name === "apply_patch") {
    const files = patchFiles(text(args.input) || text(args.patch));
    if (files.length === 0)
      return "Nodrail: this patch names no file, so it is blocked.";
    return files.map(({ path, adds }) => {
      const file_path = isAbsolute(path) || !cwd ? path : join(cwd, path);
      return as(
        adds
          ? { tool_name: "Write", tool_input: { file_path, content: "" } }
          : {
              tool_name: "Edit",
              tool_input: { file_path, old_string: "", new_string: "" },
            },
      );
    });
  }
  const builtIn = builtIns[name];
  if (builtIn) return [as(builtIn(args))];
  const mcp = mcpName(name, servers);
  return [as({ tool_name: mcp ?? name, tool_input: args })];
}

/** Claude Code's answer, as Copilot reads it. */
function decisionOf(
  result: HookResult,
): { deny: boolean; reason: string } | null {
  if (result.exitCode === 2)
    return {
      deny: true,
      reason: result.stderr.trim() || "Nodrail blocked this call.",
    };
  if (!result.stdout) return null;
  try {
    const answer = JSON.parse(result.stdout) as {
      hookSpecificOutput?: {
        permissionDecision?: string;
        permissionDecisionReason?: string;
      };
    };
    const decision = answer.hookSpecificOutput?.permissionDecision;
    // Copilot can't ask the person from a hook: a review is a deny here.
    return decision === "deny" || decision === "ask"
      ? {
          deny: true,
          reason:
            answer.hookSpecificOutput?.permissionDecisionReason ??
            "Nodrail blocked this call.",
        }
      : null;
  } catch {
    return {
      deny: true,
      reason:
        "Nodrail: the decision could not be read, so this call is blocked.",
    };
  }
}

/** One answer for the call: the first deny wins; silence lets it through. */
export function copilotAnswer(results: HookResult[]): HookResult {
  for (const result of results) {
    const decision = decisionOf(result);
    if (decision?.deny)
      return {
        stdout: JSON.stringify({
          permissionDecision: "deny",
          permissionDecisionReason: decision.reason,
        }),
        stderr: "",
        exitCode: 0,
      };
  }
  return { stdout: "", stderr: "", exitCode: 0 };
}

/** A refusal before anything was judged, as Copilot reads it. */
export const copilotRefusal = (reason: string): HookResult => ({
  stdout: JSON.stringify({
    permissionDecision: "deny",
    permissionDecisionReason: reason,
  }),
  stderr: "",
  exitCode: 0,
});

/**
 * Claude Code's hook, run by Copilot: Copilot sends Claude Code's event
 * shape with its own arguments, and sets COPILOT_HOOK_DEPTH. The call is
 * read as Copilot's, so a project set up for Claude Code stays guarded
 * when someone opens Copilot in it.
 */
export function copilotFromClaude(stdin: string) {
  try {
    const event = JSON.parse(stdin) as Record<string, unknown>;
    return JSON.stringify({
      sessionId: event.session_id,
      cwd: event.cwd,
      toolCallId: event.tool_use_id,
      toolName: event.tool_name,
      toolArgs: event.tool_input,
    });
  } catch {
    return stdin;
  }
}

/** Under Copilot, the answer Claude Code's hook gives: a deny, or nothing. */
export function claudeAnswerFor(answer: HookResult): HookResult {
  if (!answer.stdout) return answer;
  const { permissionDecisionReason } = JSON.parse(answer.stdout) as {
    permissionDecisionReason: string;
  };
  return {
    stdout: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason,
      },
    }),
    stderr: "",
    exitCode: 0,
  };
}
