/**
 * Which tools each agent checks, and how its hooks are declared. The plugins and
 * the manual setup shown in Nodrail are all generated from this one place.
 */

/**
 * Everything except tools that only read or organise, so new tools are governed
 * by default. Starting a subagent (`Agent`, or `Task` in older Claude Code) is
 * governed: a gate can hold it.
 * Without onFailure, Claude Code treats a crashed or timed-out hook as no
 * objection and runs the tool.
 */
export const governedTools =
  "^(?!(Read|Glob|Grep|LS|TodoWrite|TodoRead|AskUserQuestion|ToolSearch|ExitPlanMode|EnterPlanMode)$).*$";

/**
 * Tools that only read. They aren't sent to Nodrail, but the hook checks them
 * on the machine, so they can't reach a place where credentials live.
 */
export const localReadTools = ["Read", "Glob", "Grep"] as const;
const localReadMatcher = `^(${localReadTools.join("|")})$`;

/** A read is checked on the machine, so this needs no time for a person. */
const READ_TIMEOUT_SECONDS = 30;

/** Recording a step never waits for a person. */
const STEP_TIMEOUT_SECONDS = 30;

/** Codex's matcher has no lookahead, so here the governed tools are named. */
export const codexGovernedTools = "^(Bash|apply_patch|mcp__.*)$";

/** Slightly longer than the hook waits for a person. */
const HOOK_TIMEOUT_SECONDS = 360;

type Command = { command: string; args?: string[] };

export function claudeCodeHooks(run: Command) {
  const hook = { type: "command", ...run };
  const report = { matcher: governedTools, hooks: [hook] };
  return {
    SessionStart: [{ hooks: [hook] }],
    PreToolUse: [
      {
        matcher: governedTools,
        hooks: [{ ...hook, timeout: HOOK_TIMEOUT_SECONDS, onFailure: "block" }],
      },
      {
        matcher: localReadMatcher,
        hooks: [{ ...hook, timeout: READ_TIMEOUT_SECONDS, onFailure: "block" }],
      },
    ],
    PostToolUse: [report],
    PostToolUseFailure: [report],
    // Subagents starting and stopping are the steps of a run.
    SubagentStart: [{ hooks: [{ ...hook, timeout: STEP_TIMEOUT_SECONDS }] }],
    SubagentStop: [{ hooks: [{ ...hook, timeout: STEP_TIMEOUT_SECONDS }] }],
  };
}

export function codexHooks(command: string) {
  const hook = { type: "command", command };
  return {
    SessionStart: [{ hooks: [hook] }],
    PreToolUse: [
      {
        matcher: codexGovernedTools,
        hooks: [{ ...hook, timeout: HOOK_TIMEOUT_SECONDS }],
      },
    ],
    PostToolUse: [{ matcher: codexGovernedTools, hooks: [hook] }],
  };
}
