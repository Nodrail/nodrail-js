import { homedir } from "node:os";
import {
  allowQuietly,
  deny,
  describeToolCall,
  nonEmptyText as text,
  reachesSecret,
  type HookResult,
  type ToolInput as Input,
} from "@nodrail/policy-engine/actions";
import {
  callerCandidate,
  deferToAppliedHook,
  resolveHookCaller,
  HANDBACK_TOOL,
  receiptText,
  runKey,
} from "@nodrail/policy-engine/hook-runs";
import { blockedText } from "./blocked-text.ts";
import { resolveConnection, type Environment } from "./connection.ts";
import { localReadTools } from "./setup.ts";
import { revisionAt } from "./subject.ts";
import { hookContractFields } from "./hook-contracts.ts";
// Not ./index.ts: the hook bundles only the client, never the SDK.
import { authorize } from "./authorize.ts";
import {
  NodrailClient,
  type Decision,
  type RunRef,
  type StepEvent,
} from "./client.ts";

export {
  describeToolCall,
  redact,
  type HookResult,
} from "@nodrail/policy-engine/actions";

export const HOOK_VERSION = "0.9.0";

/** Nodrail answers at once; past this the call is denied, within the hook's own time limit. */
const HOOK_DEADLINE_MS = 25_000;

export type AgentKind = "claude-code" | "codex";

export type HookDeps = {
  fetch?: typeof fetch;
  agent?: AgentKind;
  deadlineMs?: number;
};

function clientFrom(env: Environment, deps: HookDeps) {
  const { url, credential } = resolveConnection(env);
  if (!credential) return null;
  return new NodrailClient({
    url,
    credential,
    adapterVersion: `${deps.agent ?? "claude-code"}-hook/${HOOK_VERSION}`,
    fetch: deps.fetch,
  });
}

type HookEvent = {
  hook_event_name?: unknown;
  tool_name?: unknown;
  tool_input?: unknown;
  tool_use_id?: unknown;
  cwd?: unknown;
  duration_ms?: unknown;
  is_interrupt?: unknown;
  tool_response?: unknown;
  session_id?: unknown;
  source?: unknown;
  agent_id?: unknown;
  agent_type?: unknown;
  agent_name?: unknown;
  session_agent?: unknown;
  last_assistant_message?: unknown;
};

/** The step taking a call, from the subagent fields Claude Code adds. */
function stepOf(event: HookEvent) {
  return resolveHookCaller(event, "unnamed").step;
}

/**
 * The run a call belongs to: NODRAIL_RUN, else the key pinned to the session
 * (`<repo>/<branch>`, or `session:<id>` on the default branch), the same rule
 * the local ledger uses. Without one, no run is sent.
 */
function runOf(event: HookEvent, env: Environment): RunRef | undefined {
  const key = runKey(
    text(event.cwd) ?? process.cwd(),
    text(event.session_id),
    env,
  );
  if (!key) return undefined;
  const step = stepOf(event);
  return step ? { key, step } : { key };
}

const readTools = new Set<string>(localReadTools);

/**
 * Reads are decided here, with no server: a read of a place credentials live
 * is denied, as the starter packs would, and anything else goes ahead quietly.
 * A read that can't be described is blocked.
 */
function checkReadLocally(name: string, event: HookEvent): HookResult {
  const input = event.tool_input;
  const action =
    typeof input === "object" && input !== null
      ? describeToolCall(name, input as Input, text(event.cwd))
      : null;
  if (!action)
    return deny("Nodrail: this read could not be described, so it is blocked.");
  if (reachesSecret(action.params))
    return deny(
      "Nodrail: this reads a place where credentials live, so it is blocked.",
    );
  return { exitCode: 0, stdout: "", stderr: "" };
}

const timedOut: Decision = {
  allowed: false,
  code: "TIMED_OUT",
  reason: null,
  reference: null,
};

/** The first to settle, or null once `ms` has passed. */
async function within<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<null>((done) => {
        timer = setTimeout(() => done(null), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Codex runs the tool if a hook times out, so this always answers first:
 * past the deadline the answer is a block, whatever happens meanwhile.
 */
async function decideInTime(
  ask: Promise<Decision>,
  deadlineMs: number,
): Promise<Decision> {
  return (await within(ask, deadlineMs)) ?? timedOut;
}

async function beforeTool(
  event: HookEvent,
  env: Environment,
  deps: HookDeps,
): Promise<HookResult> {
  const toolName = text(event.tool_name);
  if (toolName && readTools.has(toolName))
    return checkReadLocally(toolName, event);
  const client = clientFrom(env, deps);
  if (!client)
    return deny(
      blockedText({
        allowed: false,
        code: "NOT_CONFIGURED",
        reason: null,
        reference: null,
      }),
    );
  const name = text(event.tool_name);
  const key = text(event.tool_use_id);
  const input = event.tool_input;
  if (!name || !key || typeof input !== "object" || input === null)
    return deny(
      "Nodrail: this call could not be identified, so it is blocked.",
    );
  const descriptor = describeToolCall(name, input as Input, text(event.cwd));
  if (!descriptor)
    return deny("Nodrail: this call could not be described, so it is blocked.");
  let run: RunRef | undefined;
  try {
    run = runOf(event, env);
  } catch (error) {
    // Without its run, a budget couldn't count this call: blocked instead.
    return deny(
      `Nodrail: ${(error as Error).message} So this action is blocked.`,
    );
  }
  // What Cloud's `where` reads: the brief's reported fields, classified
  // inputs masked. Checked here, so an invalid brief never reaches Cloud.
  const fields = await hookContractFields(descriptor, input as Input, {
    cwd: text(event.cwd) ?? process.cwd(),
    env,
  });
  if ("refusal" in fields) return deny(fields.refusal);

  const decision = await decideInTime(
    authorize(client, fields.action, key, {
      run,
      agent: callerCandidate(event),
      // The work the agent's session is in, as the runtime reads it.
      subject: revisionAt(text(event.cwd) ?? process.cwd()),
    }),
    deps.deadlineMs ?? HOOK_DEADLINE_MS,
  );
  // Staying silent hands back to the agent's own permissions: a Nodrail allow
  // can only ever narrow what the agent may do, never widen it.
  return decision.allowed ? allowQuietly : deny(blockedText(decision));
}

/** Codex has no failure event; a command's exit code is in its response. */
function toolFailed(event: HookEvent) {
  if (event.hook_event_name === "PostToolUseFailure") return true;
  const response = event.tool_response;
  if (typeof response !== "object" || response === null) return false;
  const { exit_code: exitCode } = response as { exit_code?: unknown };
  return typeof exitCode === "number" && exitCode !== 0;
}

/** Never affects the tool: it has already run. */
async function afterTool(
  event: HookEvent,
  env: Environment,
  deps: HookDeps,
): Promise<HookResult> {
  const client = clientFrom(env, deps);
  const key = text(event.tool_use_id);
  if (!client || !key) return allowQuietly;
  const failed = toolFailed(event);
  // Interrupted, the call may or may not have taken effect.
  const interrupted =
    event.hook_event_name === "PostToolUseFailure" &&
    event.is_interrupt === true;
  try {
    const action = await client.findByKey(key);
    await client.report(action.action_id, {
      key,
      agent: callerCandidate(event),
      outcome: interrupted ? "unknown" : failed ? "failure" : "success",
      permitId: action.permit_id,
      details: {
        ...(typeof event.duration_ms === "number"
          ? { duration_ms: event.duration_ms }
          : {}),
        ...(event.hook_event_name === "PostToolUseFailure"
          ? { interrupted: event.is_interrupt === true }
          : {}),
      },
    });
  } catch {
    // A report is optional; losing one must not disturb the agent.
  }
  return allowQuietly;
}

/**
 * A subagent starting or stopping is a step of the run. Recording never
 * blocks the agent: a step that wasn't recorded has no verdict, so a gate
 * that needs it stays closed.
 */
async function onStep(
  event: HookEvent,
  env: Environment,
  deps: HookDeps,
): Promise<HookResult> {
  const client = clientFrom(env, deps);
  let run: RunRef | undefined;
  try {
    run = runOf(event, env);
  } catch {
    // Unrecorded, the step has no verdict, and a gate that needs it stays closed.
    return allowQuietly;
  }
  const step = run?.step;
  if (!client || !run || !step) return allowQuietly;
  const body: StepEvent = {
    run: { key: run.key },
    step,
    agent: callerCandidate(event),
    event: "started",
  };
  if (event.hook_event_name === "SubagentStop") {
    body.event = "finished";
    const block = receiptOf(text(event.last_assistant_message), step.agent);
    if (block) body.receipt = { text: block };
  }
  try {
    await client.step(body);
  } catch {
    // Without a record the step has no verdict; nothing else changes.
  }
  return allowQuietly;
}

/**
 * The receipt block that ends a message, fenced or a flat `RECEIPT <agent>`
 * header block, read from the end only; over 8 KiB is no receipt. Cloud
 * reads it against the agent's declared contract.
 */
const receiptOf = (message: string | null | undefined, agent: string) =>
  receiptText(message ?? "", agent);

/** What Cloud said of a receipt it read: refused, with a reason it is safe to show. */
function refusedReceipt(answer: unknown): string | null {
  if (typeof answer !== "object" || answer === null) return null;
  const { receipt } = answer as { receipt?: unknown };
  if (typeof receipt !== "object" || receipt === null) return null;
  const { state, reason } = receipt as { state?: unknown; reason?: unknown };
  if (state !== "invalid" && state !== "missing") return null;
  return typeof reason === "string" && reason ? reason.slice(0, 500) : state;
}

/**
 * A subagent handing back its report (Claude Code `auto` permission mode):
 * its stop event then carries no message, so the step finishes here, with
 * the receipt the hand-back carries. When Cloud refuses that receipt the
 * hand-back is denied with the reason, and the subagent resends; otherwise
 * the call is decided like any other. Cloud keeps a step's first finish, so
 * the stop that follows can't replace it.
 */
async function onHandback(
  event: HookEvent,
  env: Environment,
  deps: HookDeps,
): Promise<HookResult> {
  const started = Date.now();
  const client = clientFrom(env, deps);
  let run: RunRef | undefined;
  try {
    run = runOf(event, env);
  } catch {
    run = undefined;
  }
  const step = run?.step;
  if (client && run && step) {
    const input = event.tool_input as { message?: unknown } | null;
    const message = typeof input?.message === "string" ? input.message : "";
    const block = receiptOf(message, step.agent);
    const body: StepEvent = {
      run: { key: run.key },
      step,
      agent: callerCandidate(event),
      event: "finished",
      ...(block ? { receipt: { text: block } } : {}),
    };
    let answer: unknown = null;
    try {
      answer = await client.step(body);
    } catch {
      // Unrecorded, the step has no verdict, and a gate that needs it stays closed.
    }
    const refused = refusedReceipt(answer);
    if (refused)
      return deny(
        `Nodrail: your receipt can't be accepted: ${refused}. Hand back again with the same report, ending with a receipt that follows your contract.`,
      );
  }
  // Recording took part of the hook's time: the decision gets what is left.
  const deadlineMs =
    (deps.deadlineMs ?? HOOK_DEADLINE_MS) - (Date.now() - started);
  return beforeTool(event, env, {
    ...deps,
    deadlineMs: Math.max(0, deadlineMs),
  });
}

const notice = (message: string): HookResult => ({
  stdout: `${JSON.stringify({ systemMessage: message })}\n`,
  stderr: "",
  exitCode: 0,
});

/** The one moment to say setup is wrong, before anything gets blocked. */
async function onSessionStart(env: Environment, deps: HookDeps) {
  const client = clientFrom(env, deps);
  if (!client)
    return notice(
      "Nodrail is not connected, so governed actions will be blocked. Set NODRAIL_URL and NODRAIL_CREDENTIAL together, or save the Cloud credential to ~/.nodrail/credential.",
    );
  try {
    await client.heartbeat();
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHENTICATED")
      return notice(
        "Nodrail refused this credential, so governed actions will be blocked. Create a new one under Agents in Nodrail.",
      );
    // Otherwise the next governed call also counts as a check-in.
  }
  return allowQuietly;
}

function projectOwnsSession(
  event: HookEvent,
  env: Environment,
  agent?: AgentKind,
) {
  const session = text(event.session_id);
  const root = env.CLAUDE_PROJECT_DIR;
  if (
    !session ||
    !root ||
    agent === "codex" ||
    env.NODRAIL_REQUIRE_STANDALONE === "1"
  )
    return false;
  return deferToAppliedHook(homedir(), root, text(event.cwd) ?? process.cwd(), {
    id: session,
    starting:
      event.hook_event_name === "SessionStart" &&
      (event.source === "startup" || event.source === "resume"),
  });
}

function connectionFailure(event: HookEvent, error: string) {
  if (event.hook_event_name === "SessionStart")
    return notice(`Nodrail: ${error}`);
  if (event.hook_event_name === "PreToolUse") return deny(`Nodrail: ${error}`);
  return allowQuietly;
}

export async function runHook(
  stdin: string,
  env: Environment,
  deps: HookDeps = {},
): Promise<HookResult> {
  let event: HookEvent;
  try {
    event = JSON.parse(stdin) as HookEvent;
  } catch {
    return deny(
      "Nodrail: the hook received an unreadable event, so this action is blocked.",
    );
  }
  if (projectOwnsSession(event, env, deps.agent)) return allowQuietly;
  const { error } = resolveConnection(env);
  if (error) return connectionFailure(event, error);
  switch (event.hook_event_name) {
    case "PreToolUse":
      return event.tool_name === HANDBACK_TOOL && text(event.agent_id)
        ? onHandback(event, env, deps)
        : beforeTool(event, env, deps);
    case "PostToolUse":
    case "PostToolUseFailure":
      return afterTool(event, env, deps);
    case "SessionStart":
      return onSessionStart(env, deps);
    case "SubagentStart":
    case "SubagentStop":
      return onStep(event, env, deps);
    default:
      return deny(
        "Nodrail: unsupported hook event, so this action is blocked.",
      );
  }
}
