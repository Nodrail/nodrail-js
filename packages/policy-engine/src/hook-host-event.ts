import { allowQuietly, deny, type HookResult } from "./actions.ts";
import type { ConnectionCalls } from "./connections.ts";
import {
  claudeAnswerFor,
  copilotAnswer,
  copilotEvents,
  copilotFromClaude,
  copilotRefusal,
  copilotSettleEvent,
  copilotStepEvent,
} from "./copilot-hook.ts";
import type { HookIo } from "./hook-command.ts";
import { hostName } from "./hook-reporting.ts";
import type { Environment } from "./run-key.ts";

export type PrepareTool = (event: string) => Promise<() => HookResult>;

/** Read remote conditions together, then judge the patch's parts in host order. */
async function copilotHook(
  stdin: string,
  connections: ConnectionCalls | null,
  prepare: PrepareTool,
) {
  const events = copilotEvents(stdin, Object.keys(connections ?? {}));
  if (typeof events === "string") return copilotRefusal(events);
  const prepared = await Promise.all(events.map(prepare));
  return copilotAnswer(prepared.map((judge) => judge()));
}

/** PostToolUse and PostToolUseFailure: a call's outcome, never judged. */
export function isOutcome(stdin: string) {
  try {
    const name = (JSON.parse(stdin) as { hook_event_name?: unknown })
      .hook_event_name;
    return name === "PostToolUse" || name === "PostToolUseFailure";
  } catch {
    return false;
  }
}

/** Copilot also runs Claude Code's hooks: the call is Copilot's then. */
function copilotMode(host: string | undefined, env: Record<string, unknown>) {
  if (host === "copilot") return "own" as const;
  return env.COPILOT_HOOK_DEPTH !== undefined &&
    hostName(host) === "claude-code"
    ? ("as-claude" as const)
    : null;
}

export function answer(io: HookIo, result: HookResult) {
  if (result.stdout) io.write(result.stdout);
  if (result.stderr) io.writeError(result.stderr);
  return result.exitCode;
}

export function hostEvent(
  stdin: string,
  host: string | undefined,
  env: Environment,
) {
  const copilot = copilotMode(host, env);
  return {
    stdin,
    copilot,
    step:
      copilotStepEvent(stdin) ??
      (copilot ? copilotSettleEvent(stdin) : isOutcome(stdin) ? stdin : null),
  };
}

export function hookRefusal(
  event: ReturnType<typeof hostEvent>,
  reason: string,
) {
  if (event.step) return { ...allowQuietly, stderr: reason };
  return event.copilot === "own"
    ? copilotRefusal(reason.trim())
    : deny(reason.trim());
}

export type HostEvent = ReturnType<typeof hostEvent>;
export async function decideForHost(
  event: HostEvent,
  connections: ConnectionCalls | null,
  prepare: PrepareTool,
  finish = (result: HookResult, _copilot: boolean) => result,
) {
  const { stdin, copilot } = event;
  if (!copilot) return finish((await prepare(stdin))(), false);
  const copilotInput = copilot === "own" ? stdin : copilotFromClaude(stdin);
  const result = finish(
    await copilotHook(copilotInput, connections, prepare),
    true,
  );
  return copilot === "own" ? result : claudeAnswerFor(result);
}
