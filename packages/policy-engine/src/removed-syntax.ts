// Syntax that Nodrail no longer accepts, and what to write instead. Nothing
// waits for a person: a rule only allows or denies, and gates, budgets and
// evidence say when a call is allowed. A file still using the old words
// fails to compile with one of these messages rather than a bare enum error.

/** The removed effect, as a rule or an `otherwise` wrote it. */
export const REMOVED_EFFECT = "require_approval";

/** Why a rule's `effect: require_approval` no longer compiles. */
export const removedRuleEffect = (entry: string) =>
  `${entry} uses effect: require_approval, which was removed: a rule only allows or denies, and nothing waits for a person. Use effect: deny, and a gate, budget or evidence to say when the call is allowed.`;

/**
 * What a gate or budget does while it is unmet: always deny, so the agent is
 * told what is missing and retries once it is met. Null when `otherwise` is
 * `deny` or left out; else why it doesn't compile.
 */
export function otherwiseProblem(entry: string, otherwise: unknown) {
  if (otherwise === undefined || otherwise === "deny") return null;
  if (otherwise === REMOVED_EFFECT)
    return `${entry} uses otherwise: require_approval, which was removed: an unmet gate or budget denies the call with its reason, and the agent retries once it is met. Write otherwise: deny, or leave it out (deny is the default).`;
  return `${entry} has otherwise: ${JSON.stringify(otherwise)}; the only value is deny, the default, so leave it out or write otherwise: deny.`;
}

const INSTEAD =
  "nothing waits for a person. A rule allows or denies, and a gate, budget or evidence says when a call is allowed.";

/** Keys that were removed, and what each one's file is told. */
export const REMOVED_KEYS: Readonly<Record<string, string>> = {
  approvals: `approvals (approval forms) was removed: ${INSTEAD}`,
  approval: `approval (a link to an approval form) was removed: ${INSTEAD}`,
};

/**
 * A schema issue as its file is told it: an unknown key that was removed
 * says so and what to use instead; any other issue keeps its own message.
 */
export function issueMessage(issue: {
  code?: string;
  message: string;
  keys?: readonly PropertyKey[];
}) {
  if (issue.code !== "unrecognized_keys") return issue.message;
  const removed = (issue.keys ?? []).find(
    (key) => typeof key === "string" && Object.hasOwn(REMOVED_KEYS, key),
  );
  return removed === undefined
    ? issue.message
    : REMOVED_KEYS[removed as string]!;
}
