import type { Decision } from "./client.ts";

/**
 * Why, when Cloud says so: an agent told a gate waits for steps of the run can
 * run them and try again, instead of stopping.
 */
const why: Record<string, string> = {
  gate: " A gate in your rules holds it until the steps it waits for, such as QA or review, have finished with an accepted verdict after the last change. Run those steps, then try again.",
  budget: " A budget in your rules for this run or step is used up.",
  no_rule:
    " No rule covers this call. If it should run, add a rule that allows it, then try again.",
  agent_paused: " This agent is paused in Nodrail.",
};

/** Blocks that say the same whatever the request. */
const fixed: Record<string, string> = {
  NOT_CONFIGURED:
    "Nodrail: not configured, so this action is blocked. Set NODRAIL_CREDENTIAL or save it to ~/.nodrail/credential.",
  INSECURE_URL:
    "Nodrail: its address must use https (plain http only for this machine), so the credential isn't sent and this action is blocked.",
  UNAUTHENTICATED:
    "Nodrail: the credential was refused, so this action is blocked.",
  QUOTA_EXCEEDED:
    "Nodrail: this workspace has used its agent actions for the month, so this action is blocked.",
  RATE_LIMITED:
    "Nodrail: too many calls in a short time, so this action is blocked. Try again in a minute.",
  CONTRACT_REFUSED:
    "Nodrail: this call doesn't follow its declared contract, so it is blocked.",
};

/** What an agent, and the person reading its output, is told about a block. */
export function blockedText(decision: Extract<Decision, { allowed: false }>) {
  // Said here, from the declared contract: paths and codes, never values.
  if (decision.code === "CONTRACT_REFUSED" && decision.reason)
    return decision.reason;
  const constant = fixed[decision.code];
  if (constant) return constant;
  const reference = decision.reference ? ` Request ${decision.reference}.` : "";
  const because = (decision.reason && why[decision.reason]) ?? "";
  switch (decision.code) {
    case "DENIED":
      return `Nodrail: this action is denied.${reference}${because}`;
    case "EXPIRED":
      return `Nodrail: the request expired before it was used.${reference} Try again.`;
    case "INVALIDATED":
      return `Nodrail: the request was closed because something changed.${reference} Try again to ask for a new decision.`;
    default:
      // Any other answer, a hold from an older server included, is a deny.
      return `Nodrail: could not confirm this action is allowed (${decision.code}), so it is denied.${reference}${because}`;
  }
}
