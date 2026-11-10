import type { Decision } from "./index.ts";

/** What an agent, and the person reading its output, is told about a block. */
export function blockedText(decision: Extract<Decision, { allowed: false }>) {
  const reference = decision.reference ? ` Request ${decision.reference}.` : "";
  switch (decision.code) {
    case "APPROVAL_PENDING":
    case "UNKNOWN_PERMISSION_BLOCKED":
      return `Nodrail: still waiting for a person to review this.${reference} It stays blocked; try again after it is allowed.`;
    case "DENIED":
      return `Nodrail: this action is denied.${reference}`;
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
