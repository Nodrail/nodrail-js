// Rules written for an earlier engine that would now quietly never match.
// Pure, so Cloud's rule form can ask the same question.

/** The fields of a rule that say what it matches. */
export type RuleTarget = {
  toolKey: string;
  operationKey: string;
  resourceKind: string;
};

const same = (value: string, expected: string) =>
  value.trim().toLowerCase() === expected;

/**
 * Why a rule written for starting a subagent before engine level 3 can't be
 * used, or null. Starting a subagent is resource kind `agent` now, so a rule
 * on kind `tool` would never match it, and the subagent would be blocked.
 */
export function legacySubagentRuleProblem({
  toolKey,
  operationKey,
  resourceKind,
}: RuleTarget): string | null {
  if (
    !same(toolKey, "claude-code") ||
    !same(operationKey, "agent") ||
    !same(resourceKind, "tool")
  )
    return null;
  return "Starting a subagent is resource kind agent, so a rule on kind tool never matches it. Write resource: { kind: agent, match: any }, or match: exact with the subagent's type. See docs/runs.md#upgrading-rules-for-subagents.";
}
