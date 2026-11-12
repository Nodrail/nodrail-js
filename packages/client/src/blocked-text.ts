import type { Decision } from "./index.ts";

/**
 * Why, when Cloud says so: an agent told a gate waits for steps of the run can
 * run them and try again, instead of stopping.
 */
const why: Record<string, string> = {
  gate: " A gate in your rules holds it until the steps it waits for, such as QA or review, have finished with an accepted verdict after the last change. Run those steps, then try again.",
  budget: " A budget in your rules for this run or step is used up.",
  agent_paused: " This agent is paused in Nodrail.",
};

/** What an agent, and the person reading its output, is told about a block. */
export function blockedText(decision: Extract<Decision, { allowed: false }>) {
  const reference = decision.reference ? ` Request ${decision.reference}.` : "";
  const because = (decision.reason && why[decision.reason]) ?? "";
  switch (decision.code) {
    case "APPROVAL_PENDING":
    case "UNKNOWN_PERMISSION_BLOCKED":
      return `Nodrail: still waiting for a person to review this.${reference}${because} It stays blocked; try again after it is allowed.`;
    case "DENIED":
      return `Nodrail: this action is denied.${reference}${because}`;
    case "EXPIRED":
      return `Nodrail: the request expired before anyone decided.${reference}`;
    case "INVALIDATED":
      return `Nodrail: the request was closed because something changed.${reference} Try again to ask for a new decision.`;
    case "NOT_CONFIGURED":
      return "Nodrail: not configured, so this action is blocked. Set NODRAIL_CREDENTIAL or save it to ~/.nodrail/credential.";
    case "INSECURE_URL":
      return "Nodrail: its address must use https (plain http only for this machine), so the credential isn't sent and this action is blocked.";
    case "UNAUTHENTICATED":
      return "Nodrail: the credential was refused, so this action is blocked.";
    case "QUOTA_EXCEEDED":
      return "Nodrail: this workspace has used its agent actions for the month, so this action is blocked.";
    case "RATE_LIMITED":
      return "Nodrail: too many calls in a short time, so this action is blocked. Try again in a minute.";
    default:
      return `Nodrail: could not confirm this action is allowed (${decision.code}), so it is blocked.`;
  }
}
