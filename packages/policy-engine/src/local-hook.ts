import {
  allowQuietly,
  askPerson,
  deny,
  describeToolCall,
  nonEmptyText,
  type HookResult,
  type ToolInput,
} from "./actions.ts";
import type { Descriptor } from "./evaluator.ts";
import type { PolicyDocument } from "./policies.ts";
import type { ActionDescriptor } from "./protocol.ts";
import type { RunContext } from "./runs.ts";
import { touchedRules } from "./rules-guard.ts";
import { simulate, type SimulationResult } from "./simulator.ts";

export type Identity = { agent?: string; installation?: string };

export const toDescriptor = (
  action: ActionDescriptor,
  { agent, installation }: Identity = {},
): Descriptor => ({
  agentId: agent ?? "local-agent",
  installationId: installation ?? "local-install",
  toolKey: action.tool,
  operationKey: action.operation,
  resourceKind: action.resource.kind,
  resourceId: action.resource.id,
  params: action.params as Descriptor["params"],
});

export type LocalHookOptions = Identity & {
  document: PolicyDocument;
  now: Date;
  /** What to do when no rule covers a call. Blocked unless asked otherwise. */
  unmatched: "deny" | "ask";
  /** The run this call belongs to, when the rules have gates or budgets. */
  run?: RunContext | null;
  /** Rule files and folders no file tool may change, whatever the rules say. */
  protect?: readonly string[];
};

export const parseEvent = (stdin: string) => {
  try {
    return JSON.parse(stdin) as {
      hook_event_name?: unknown;
      tool_name?: unknown;
      tool_input?: unknown;
      cwd?: unknown;
    };
  } catch {
    return null;
  }
};

export type Judged = {
  result: HookResult;
  /** What was decided, when the call could be described at all. */
  action: ActionDescriptor | null;
  decision: SimulationResult | null;
};

const refused = (text: string): Judged => ({
  result: deny(text),
  action: null,
  decision: null,
});

const heldByRun = (decision: SimulationResult) =>
  decision.reason === "gate" || decision.reason === "budget";

/** A gate waits for something; a used-up budget stays used up for the step or run. */
const holdLead = (decision: SimulationResult) =>
  decision.reason === "budget" ? "Over the limit," : "Until then,";

/** A rule says what it does; a gate or budget says what it is waiting for. */
function denied(decision: SimulationResult, subject: string) {
  return heldByRun(decision)
    ? `Nodrail: ${decision.explanation} ${holdLead(decision)} ${subject} is denied.`
    : `Nodrail: rule ${decision.matchedRuleId} denies ${subject}.`;
}

function toReview(decision: SimulationResult, subject: string) {
  return heldByRun(decision)
    ? `Nodrail: ${decision.explanation} ${holdLead(decision)} a person must review ${subject}.`
    : `Nodrail: rule ${decision.matchedRuleId} needs a person to review ${subject}.`;
}

/**
 * Decides a Claude Code PreToolUse event from local rules, with no server.
 * Nobody is waiting to review here, so a review goes to the person at the keyboard.
 */
export function judgeToolCall(
  stdin: string,
  options: LocalHookOptions,
): Judged {
  const event = parseEvent(stdin);
  if (event?.hook_event_name !== "PreToolUse")
    return refused(
      "Nodrail: unsupported hook event, so this action is blocked.",
    );
  const name = nonEmptyText(event.tool_name);
  const input = event.tool_input;
  if (!name || typeof input !== "object" || input === null)
    return refused(
      "Nodrail: this call could not be identified, so it is blocked.",
    );
  const action = describeToolCall(
    name,
    input as ToolInput,
    nonEmptyText(event.cwd),
  );
  if (!action)
    return refused(
      "Nodrail: this call could not be described, so it is blocked.",
    );
  const rules = touchedRules(action, options.protect ?? []);
  if (rules)
    return refused(
      `Nodrail: ${rules} holds the rules this hook enforces, so changing it is denied. Change your rules yourself, outside the agent.`,
    );

  const { document, now, unmatched, run } = options;
  const decision = simulate({
    document,
    descriptor: toDescriptor(action, options),
    now,
    run,
  });
  const subject = `${action.tool} ${action.operation} on ${action.resource.id}`;
  const judged = (result: HookResult) => ({ result, action, decision });
  switch (decision.outcome) {
    case "allow":
      // Silence defers to Claude Code's permissions: a rule can only narrow them.
      return judged(allowQuietly);
    case "deny":
      return judged(deny(denied(decision, subject)));
    case "require_approval":
      return judged(askPerson(toReview(decision, subject)));
    default:
      return judged(
        (unmatched === "ask" ? askPerson : deny)(
          `Nodrail: no rule covers ${subject}.`,
        ),
      );
  }
}

export function decideToolCall(
  stdin: string,
  options: LocalHookOptions,
): HookResult {
  return judgeToolCall(stdin, options).result;
}
