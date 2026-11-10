import {
  allowQuietly,
  deny,
  describeToolCall,
  nonEmptyText as text,
  type HookResult,
  type ToolInput as Input,
} from "@nodrail/policy-engine/actions";
import { blockedText } from "./blocked-text";
import { resolveConnection, waitMsFrom, type Environment } from "./connection";
import { authorize, NodrailClient, type Decision } from "./index";

export {
  describeToolCall,
  redact,
  type HookResult,
} from "@nodrail/policy-engine/actions";

export const HOOK_VERSION = "0.1.1";

/** Longer than the wait for a person, shorter than the hook's own time limit. */
const HOOK_DEADLINE_MS = 345_000;

export type AgentKind = "claude-code" | "codex";

export type HookDeps = {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
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
};

async function beforeTool(
  event: HookEvent,
  env: Environment,
  deps: HookDeps,
): Promise<HookResult> {
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
    return deny(
      "Nodrail: this call could not be described for review, so it is blocked.",
    );

  // Codex runs the tool if a hook times out, so this always answers first.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const decision = await Promise.race([
    authorize(client, descriptor, key, {
      waitMs: waitMsFrom(env),
      sleep: deps.sleep,
    }),
    new Promise<Decision>((done) => {
      timer = setTimeout(
        () =>
          done({
            allowed: false,
            code: "TIMED_OUT",
            reason: null,
            reference: null,
          }),
        deps.deadlineMs ?? HOOK_DEADLINE_MS,
      );
    }),
  ]);
  clearTimeout(timer);
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
  try {
    const action = await client.findByKey(key);
    await client.report(action.action_id, {
      key,
      outcome: failed ? "failure" : "success",
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
      "Nodrail is not connected, so governed actions will be blocked. Set NODRAIL_CREDENTIAL or save it to ~/.nodrail/credential.",
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
  switch (event.hook_event_name) {
    case "PreToolUse":
      return beforeTool(event, env, deps);
    case "PostToolUse":
    case "PostToolUseFailure":
      return afterTool(event, env, deps);
    case "SessionStart":
      return onSessionStart(env, deps);
    default:
      return deny(
        "Nodrail: unsupported hook event, so this action is blocked.",
      );
  }
}
