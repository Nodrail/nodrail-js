// The Claude Code hook with a run ledger, used when the rules have gates,
// budgets or contracts. Rules without them never touch the ledger: see
// hookCommand.
import { randomUUID } from "node:crypto";
import { deny, nonEmptyText, type HookResult } from "./actions.ts";
import { earlierDelivery, reservationsFor, settle } from "./budget-ledger.ts";
import { isChange } from "./changes.ts";
import { HANDBACK_TOOL } from "./hook-runs.ts";
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
import { hasContracts, limitsOf } from "./policies.ts";
import { fingerprint } from "./protocol.ts";
import { agentName, MAIN_AGENT, type RunEvent } from "./runs.ts";
import {
  finishedBefore,
  finishedEvent,
  subjectReader,
  type Step,
} from "./run-steps.ts";

const quiet: HookResult = { exitCode: 0, stdout: "", stderr: "" };

type Where = { directory: string; run: string | null; cwd: string };
type Event = Record<string, unknown>;

function where(event: Event, env: Environment): Where {
  const cwd = nonEmptyText(event.cwd) ?? process.cwd();
  return {
    directory: ledgerDirectory(cwd, env),
    run: runKey(cwd, nonEmptyText(event.session_id), env),
    cwd,
  };
}

const stepOf = (event: Event): Step | null => {
  const id = nonEmptyText(event.agent_id);
  if (!id) return null;
  return { id, agent: agentName(nonEmptyText(event.agent_type) ?? "unnamed") };
};

/** Reporting is told after the ledger has the event; it never blocks. */
function reported(
  options: Pick<LocalHookOptions, "report">,
  run: string,
  entry: RunEvent,
) {
  try {
    options.report?.(run, entry);
  } catch {
    // Telemetry never changes a decision.
  }
}

/**
 * The stop event's final message. Without contracts, as it always was read.
 * With them, a stop with no `last_assistant_message` delivered none (the
 * step handed back instead, or the host sent nothing): never an empty one.
 */
function stopMessage(event: Event, options: LocalHookOptions) {
  const said = event.last_assistant_message;
  if (!hasContracts(options.document)) return nonEmptyText(said) ?? "";
  return typeof said === "string" ? said : null;
}

/** The entry a start or stop records, or null when the step already finished. */
function stepEntry(
  event: Event,
  step: Step,
  place: Where & { run: string },
  options: LocalHookOptions,
) {
  const at = options.now.toISOString();
  if (event.hook_event_name === "SubagentStart")
    return {
      type: "step.started",
      step: step.id,
      agent: step.agent,
      at,
    } as const;
  // With contracts a step completes once, however many paths deliver it.
  // Without them, a stop that carries no message after the step handed
  // back (Claude Code `auto` mode) adds nothing: the hand-back finished it.
  const once =
    hasContracts(options.document) ||
    !Object.hasOwn(event, "last_assistant_message");
  if (once && finishedBefore(readRun(place.directory, place.run), step))
    return null;
  return finishedEvent({
    document: options.document,
    step,
    message: stopMessage(event, options),
    via: "stop",
    at,
    cwd: place.cwd,
  });
}

/**
 * A step starting or finishing. Recording never blocks the agent: a step that
 * failed to record has no verdict, and a gate that needs it stays closed.
 */
function recordStep(
  event: Event,
  place: Where,
  options: LocalHookOptions,
): HookResult {
  const step = stepOf(event);
  const { run } = place;
  if (!run || !step) return quiet;
  try {
    withRunLock(place.directory, run, () => {
      const entry = stepEntry(event, step, { ...place, run }, options);
      if (!entry) return;
      record(place.directory, run, entry);
      reported(options, run, entry);
    });
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

type Decided = { result: HookResult; wentAhead: boolean };

const KEY = /^[a-z][a-z0-9-]{0,31}:[\x21-\x7e]{1,200}$/;

/** The call's key, `host:tool_use_id`, or null when the host gave no id. */
function callKey(event: Event, options: LocalHookOptions) {
  const id = nonEmptyText(event.tool_use_id);
  const key = `${options.keyHost ?? options.host ?? "claude-code"}:${id}`;
  return id && KEY.test(key) ? key : null;
}

/** The input digest a mediated connector gives the same call. */
function inputDigest(event: Event) {
  try {
    return fingerprint(event.tool_input ?? null);
  } catch {
    return null;
  }
}

/**
 * What a call that goes ahead sets aside in each numeric budget that covers
 * it. Without a key from the host it can never be settled: it stays counted.
 */
function reserve(
  event: Event,
  options: LocalHookOptions,
  call: {
    key: string | null;
    decision: NonNullable<ReturnType<typeof judgeToolCall>["decision"]>;
    action: { tool: string; operation: string };
    step: string | null;
    agent: string;
  },
) {
  const limits = call.decision.limits ?? [];
  if (!limits.length) return [];
  const host = options.keyHost ?? options.host ?? "claude-code";
  return reservationsFor(limits, limitsOf(options.document), {
    key: call.key ?? `${host}:unkeyed-${randomUUID()}`,
    tool: call.action.tool,
    operation: call.action.operation,
    step: call.step,
    agent: call.agent,
    at: options.now.toISOString(),
    input_sha256: inputDigest(event),
  });
}

/**
 * A tool call, decided with the run's history, then recorded in it, while no
 * other hook works on the run: two calls at once can't both pass a budget's
 * last slot, nor be decided without seeing each other.
 */
function decideAndRecord(
  stdin: string,
  event: Event,
  options: LocalHookOptions,
  { directory, run, cwd }: Where & { run: string },
): Decided {
  const step = stepOf(event);
  const key = callKey(event, options);
  const events = readRun(directory, run);
  // A host that delivers the same call again gets the decision it got the
  // first time, judged on the history then, and nothing is counted twice.
  const earlier = key ? earlierDelivery(events, key) : -1;
  const history = earlier >= 0 ? events.slice(0, earlier) : events;
  const context = { run, step, events: history };
  const { result, action, decision } = judgeToolCall(stdin, {
    ...options,
    run: context,
    subject: subjectReader(options.document, cwd),
    budgets: "local",
  });
  if (!action || !decision) return { result, wentAhead: false };
  const ahead = wentAhead(decision.outcome, options.unmatched);
  if (earlier >= 0) return { result, wentAhead: false };
  try {
    const entry: RunEvent = {
      type: "action",
      step: step?.id ?? null,
      agent: step?.agent ?? MAIN_AGENT,
      at: options.now.toISOString(),
      tool: action.tool,
      operation: action.operation,
      outcome: decision.outcome,
      change: isChange(action) && ahead,
      ...(key ? { key } : {}),
    };
    record(directory, run, entry);
    reported(options, run, entry);
    // Reserved in the same lock as the decision: no other call can take the
    // slot in between.
    if (ahead)
      for (const reservation of reserve(event, options, {
        key,
        decision,
        action,
        step: entry.step,
        agent: entry.agent,
      })) {
        record(directory, run, reservation);
        reported(options, run, reservation);
      }
  } catch (error) {
    // Unrecorded, the call would not count against a budget.
    return {
      result: deny(`Nodrail: ${String(error)} So this action is blocked.`),
      wentAhead: false,
    };
  }
  const warnings = decision.warnings.map((text) => `Nodrail: ${text}\n`);
  return {
    result: { ...result, stderr: result.stderr + warnings.join("") },
    wentAhead: ahead,
  };
}

/** A hand-back's receipt is refused before delivery; the subagent then resends. */
const resend = (reason: string) =>
  deny(
    `Nodrail: your receipt can't be accepted: ${reason}. Hand back again with the same report, ending with a receipt that follows your contract.`,
  );

/**
 * A subagent handing back its report (Claude Code `auto` permission mode):
 * its stop event then carries no message, so the hand-back finishes the
 * step, once the rules let it through, and the stop records nothing more.
 * With contracts the receipt is read before delivery, and an invalid or
 * missing one is refused, so the subagent resends; without them it is read
 * as a stop's would be.
 */
function handback(
  stdin: string,
  event: Event,
  options: LocalHookOptions,
  place: Where & { run: string },
) {
  const step = stepOf(event)!;
  const input = event.tool_input as { message?: unknown } | null;
  return withRunLock(place.directory, place.run, () => {
    const done = finishedBefore(readRun(place.directory, place.run), step);
    const entry = done
      ? null
      : finishedEvent({
          document: options.document,
          step,
          message: typeof input?.message === "string" ? input.message : null,
          via: "handback",
          at: options.now.toISOString(),
          cwd: place.cwd,
        });
    if (entry?.receipt && entry.receipt.state !== "valid")
      return resend(entry.receipt.reason ?? "it doesn't follow the contract");
    const decided = decideAndRecord(stdin, event, options, place);
    if (entry && decided.wentAhead) {
      record(place.directory, place.run, entry);
      reported(options, place.run, entry);
    }
    return decided.result;
  });
}

/** The tokens a finished subagent used, as the host measured them; null when it didn't. */
function tokensOf(event: Event) {
  const response = event.tool_response as { totalTokens?: unknown } | null;
  const total =
    typeof response === "object" && response !== null
      ? response.totalTokens
      : undefined;
  return typeof total === "number" && Number.isSafeInteger(total) && total >= 0
    ? total
    : null;
}

const SUBAGENT_TOOLS = new Set(["Agent", "Task"]);

/**
 * A call's outcome (PostToolUse, PostToolUseFailure): its reservations are
 * consumed when it ran, and unknown when it failed with no mediated record
 * saying the provider never had it, which a connector settles itself. A
 * subagent's tokens are measured when a budget counts them; none is
 * unknown, never zero. Never blocks: the call already happened.
 */
function settleCall(event: Event, options: LocalHookOptions, place: Where) {
  const { run } = place;
  const key = callKey(event, options);
  if (!run || !key) return quiet;
  const failed = event.hook_event_name === "PostToolUseFailure";
  const measures = limitsOf(options.document).some(
    (limit) => limit.measure.kind === "tokens",
  );
  try {
    withRunLock(place.directory, run, () => {
      const events = readRun(place.directory, run);
      const at = options.now.toISOString();
      const entries: RunEvent[] = [];
      const settled = settle(events, key, failed ? "unknown" : "consumed", at);
      if (settled) entries.push(settled);
      const step = stepOf(event);
      if (
        measures &&
        SUBAGENT_TOOLS.has(nonEmptyText(event.tool_name) ?? "") &&
        !events.some((e) => e.type === "budget.measured" && e.key === key)
      )
        entries.push({
          type: "budget.measured",
          step: step?.id ?? null,
          agent: step?.agent ?? MAIN_AGENT,
          at,
          key,
          tool: options.host === "codex" ? "codex" : "claude-code",
          operation: "agent",
          path: "tokens",
          amount: failed ? null : tokensOf(event),
        });
      for (const entry of entries) {
        record(place.directory, run, entry);
        reported(options, run, entry);
      }
    });
    return quiet;
  } catch (error) {
    return { ...quiet, stderr: `Nodrail: ${String(error)}\n` };
  }
}

const isHandback = (event: Event, options: LocalHookOptions) =>
  options.document.version !== 1 &&
  event.tool_name === HANDBACK_TOOL &&
  stepOf(event) !== null;

function decideInRun(
  stdin: string,
  event: Event,
  options: LocalHookOptions,
  place: Where,
) {
  const { directory, run } = place;
  if (!run)
    return judgeToolCall(stdin, {
      ...options,
      run: null,
      subject: subjectReader(options.document, place.cwd),
    }).result;
  try {
    const here = { ...place, run };
    return isHandback(event, options)
      ? handback(stdin, event, options, here)
      : withRunLock(
          directory,
          run,
          () => decideAndRecord(stdin, event, options, here).result,
        );
  } catch (error) {
    // The history couldn't be read, or another hook held the run too long.
    return deny(`Nodrail: ${String(error)} So this action is blocked.`);
  }
}

/**
 * PreToolUse decides; SubagentStart and SubagentStop record steps, and with
 * contracts a SubagentHandback call finishes its step. The run is
 * NODRAIL_RUN, else the key pinned to the Claude Code session: see runKey.
 */
export function runHook(
  stdin: string,
  options: LocalHookOptions,
  env: Environment = process.env,
): HookResult {
  const event = parseEvent(stdin) as Event | null;
  const name = event?.hook_event_name;
  const step = name === "SubagentStart" || name === "SubagentStop";
  const post = name === "PostToolUse" || name === "PostToolUseFailure";
  if (event && post) {
    try {
      return settleCall(event, options, where(event, env));
    } catch (error) {
      return { ...quiet, stderr: `Nodrail: ${(error as Error).message}\n` };
    }
  }
  if (!event || (!step && name !== "PreToolUse"))
    return judgeToolCall(stdin, options).result;
  let place: Where;
  try {
    place = where(event, env);
  } catch (error) {
    // Where the run is kept is unknown: a call is blocked, and a step goes
    // unrecorded, so a gate that needs it stays closed.
    const reason = `Nodrail: ${(error as Error).message}`;
    return step
      ? { ...quiet, stderr: `${reason} The step isn't recorded.\n` }
      : deny(`${reason} So this action is blocked.`);
  }
  return step
    ? recordStep(event, place, options)
    : decideInRun(stdin, event, options, place);
}
