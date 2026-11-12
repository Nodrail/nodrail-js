// The Claude Code hook with a run ledger, used when the rules have gates or
// budgets. Rules without them never touch the ledger: see hookCommand.
import { deny, nonEmptyText, type HookResult } from "./actions.ts";
import { isChange } from "./changes.ts";
import {
  ledgerDirectory,
  readRun,
  record,
  runKey,
  withRunLock,
  type Environment,
} from "./ledger.ts";
import {
  judgeToolCall,
  parseEvent,
  type LocalHookOptions,
} from "./local-hook.ts";
import { parseReceipt } from "./receipts.ts";
import { agentName, MAIN_AGENT, type RunEvent } from "./runs.ts";

const quiet: HookResult = { exitCode: 0, stdout: "", stderr: "" };

type Where = { directory: string; run: string | null };

function where(event: Record<string, unknown>, env: Environment): Where {
  const cwd = nonEmptyText(event.cwd) ?? process.cwd();
  return {
    directory: ledgerDirectory(cwd, env),
    run: runKey(cwd, nonEmptyText(event.session_id), env),
  };
}

const stepOf = (event: Record<string, unknown>) => {
  const id = nonEmptyText(event.agent_id);
  if (!id) return null;
  return { id, agent: agentName(nonEmptyText(event.agent_type) ?? "unnamed") };
};

/**
 * A step starting or finishing. Recording never blocks the agent: a step that
 * failed to record has no verdict, and a gate that needs it stays closed.
 */
function recordStep(
  event: Record<string, unknown>,
  { directory, run }: Where,
  now: Date,
): HookResult {
  const step = stepOf(event);
  if (!run || !step) return quiet;
  const at = now.toISOString();
  const receipt =
    event.hook_event_name === "SubagentStart"
      ? null
      : parseReceipt(nonEmptyText(event.last_assistant_message) ?? "");
  const entry: RunEvent =
    event.hook_event_name === "SubagentStart"
      ? { type: "step.started", step: step.id, agent: step.agent, at }
      : {
          type: "step.finished",
          step: step.id,
          agent: step.agent,
          at,
          verdict: receipt?.verdict ?? null,
          findings: receipt?.findings ?? [],
          usage: receipt?.usage ?? {},
        };
  try {
    withRunLock(directory, run, () => record(directory, run, entry));
    return quiet;
  } catch (error) {
    return { ...quiet, stderr: `Nodrail: ${String(error)}\n` };
  }
}

/** Whether the call goes ahead, or goes to the person who may let it. */
const wentAhead = (outcome: string, unmatched: LocalHookOptions["unmatched"]) =>
  outcome === "allow" ||
  outcome === "require_approval" ||
  (outcome === "none" && unmatched === "ask");

/**
 * A tool call, decided with the run's history, then recorded in it, while no
 * other hook works on the run: two calls at once can't both pass a budget's
 * last slot, nor be decided without seeing each other.
 */
function decideAndRecord(
  stdin: string,
  event: Record<string, unknown>,
  options: LocalHookOptions,
  { directory, run }: { directory: string; run: string },
): HookResult {
  const step = stepOf(event);
  const context = { run, step, events: readRun(directory, run) };
  const { result, action, decision } = judgeToolCall(stdin, {
    ...options,
    run: context,
  });
  if (!action || !decision) return result;
  try {
    record(directory, run, {
      type: "action",
      step: step?.id ?? null,
      agent: step?.agent ?? MAIN_AGENT,
      at: options.now.toISOString(),
      tool: action.tool,
      operation: action.operation,
      outcome: decision.outcome,
      change:
        isChange(action) && wentAhead(decision.outcome, options.unmatched),
    });
  } catch (error) {
    // Unrecorded, the call would not count against a budget.
    return deny(`Nodrail: ${String(error)} So this action is blocked.`);
  }
  const warnings = decision.warnings.map((text) => `Nodrail: ${text}\n`);
  return { ...result, stderr: result.stderr + warnings.join("") };
}

function decideInRun(
  stdin: string,
  event: Record<string, unknown>,
  options: LocalHookOptions,
  { directory, run }: Where,
): HookResult {
  if (!run) return judgeToolCall(stdin, { ...options, run: null }).result;
  try {
    return withRunLock(directory, run, () =>
      decideAndRecord(stdin, event, options, { directory, run }),
    );
  } catch (error) {
    // The history couldn't be read, or another hook held the run too long.
    return deny(`Nodrail: ${String(error)} So this action is blocked.`);
  }
}

/**
 * PreToolUse decides; SubagentStart and SubagentStop record steps. The run is
 * NODRAIL_RUN, else the key pinned to the Claude Code session: see runKey.
 */
export function runHook(
  stdin: string,
  options: LocalHookOptions,
  env: Environment = process.env,
): HookResult {
  const event = parseEvent(stdin) as Record<string, unknown> | null;
  const name = event?.hook_event_name;
  if (event && (name === "SubagentStart" || name === "SubagentStop"))
    return recordStep(event, where(event, env), options.now);
  if (event && name === "PreToolUse")
    return decideInRun(stdin, event, options, where(event, env));
  return judgeToolCall(stdin, options).result;
}
