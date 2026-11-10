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
import { simulate } from "./simulator.ts";

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
};

const parseEvent = (stdin: string) => {
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

/**
 * Decides a Claude Code PreToolUse event from local rules, with no server.
 * Nobody is waiting to review here, so a review goes to the person at the keyboard.
 */
export function decideToolCall(
  stdin: string,
  options: LocalHookOptions,
): HookResult {
  const event = parseEvent(stdin);
  if (event?.hook_event_name !== "PreToolUse")
    return deny("Nodrail: unsupported hook event, so this action is blocked.");
  const name = nonEmptyText(event.tool_name);
  const input = event.tool_input;
  if (!name || typeof input !== "object" || input === null)
    return deny(
      "Nodrail: this call could not be identified, so it is blocked.",
    );
  const action = describeToolCall(
    name,
    input as ToolInput,
    nonEmptyText(event.cwd),
  );
  if (!action)
    return deny("Nodrail: this call could not be described, so it is blocked.");

  const { document, now, unmatched } = options;
  const { outcome, matchedRuleId } = simulate({
    document,
    descriptor: toDescriptor(action, options),
    now,
  });
  const subject = `${action.tool} ${action.operation} on ${action.resource.id}`;
  switch (outcome) {
    case "allow":
      // Silence defers to Claude Code's permissions: a rule can only narrow them.
      return allowQuietly;
    case "deny":
      return deny(`Nodrail: rule ${matchedRuleId} denies ${subject}.`);
    case "require_approval":
      return askPerson(
        `Nodrail: rule ${matchedRuleId} needs a person to review ${subject}.`,
      );
    default:
      return (unmatched === "ask" ? askPerson : deny)(
        `Nodrail: no rule covers ${subject}.`,
      );
  }
}
