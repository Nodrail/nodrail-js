// What a finished step proves to a gate requirement (C01), and why it falls
// short. A receipt is agent-reported: a valid one proves conformance, not
// truth, so its own `anchor: fresh` or `tests: passed` never stands in for
// what the runtime observed (`since`, `subject`).
import type { Requirement } from "./policies.ts";
import type { RunEvent } from "./runs.ts";
import { satisfiesAuthority } from "./shapes/authority.ts";
import type { CompiledCondition } from "./shapes/types.ts";
import { matchWhere } from "./shapes/validate.ts";

type Finished = Extract<RunEvent, { type: "step.finished" }>;

/** The revision the work is at now, read only when a requirement needs it. */
export type Subject = () => string | null;

/** Why a finished step doesn't meet the requirement, or null when it does. */
export function shortfall(
  event: Finished,
  requirement: Requirement,
  subject: Subject | null,
): string | null {
  return (
    receiptShortfall(event, requirement) ??
    valueShortfall(event, requirement) ??
    subjectShortfall(event, requirement, subject)
  );
}

/** With a contract: only a valid receipt, read with the pinned contract, counts. */
function receiptShortfall(event: Finished, requirement: Requirement) {
  if (!requirement.contract) return null;
  const { receipt } = event;
  if (!receipt || receipt.state === "missing")
    return `its last step ended without a ${requirement.agent} receipt`;
  if (receipt.state === "invalid") {
    const issues = receipt.issues.map((i) => `${i.path}: ${i.code}`);
    return `its last receipt was invalid (${issues.join(", ") || receipt.reason})`;
  }
  if (receipt.contract !== requirement.contract)
    return "its last receipt was validated against another revision of the contract";
  return null;
}

function valueShortfall(event: Finished, requirement: Requirement) {
  if (event.verdict === null) return "its last step ended without a verdict";
  if (!requirement.verdicts.includes(event.verdict))
    return `its last verdict was ${event.verdict}`;
  // A receipt is agent-reported; nothing it says can prove more.
  if (
    !satisfiesAuthority(
      "agent-reported",
      requirement.authority ?? "agent-reported",
    )
  )
    return "a receipt is agent-reported";
  const where = requirement.where ?? [];
  if (where.length && !matchWhere(where, event.receipt?.value ?? null))
    return "its last receipt doesn't meet the where conditions";
  return null;
}

/** Freshness the runtime observed: the revision then equals the revision now. */
function subjectShortfall(
  event: Finished,
  requirement: Requirement,
  subject: Subject | null,
) {
  if (requirement.subject !== "revision") return null;
  const now = subject?.() ?? null;
  if (!event.subject || !now) return "the revision it reviewed is unknown";
  return event.subject === now ? null : "the work changed after its receipt";
}

const shown = (value: unknown) =>
  typeof value === "string" ? value : String(value);

function describeCondition(condition: CompiledCondition) {
  const path = condition.path.join(".");
  if (condition.op === "eq") return `${path} is ${shown(condition.value)}`;
  if (condition.op === "in")
    return `${path} is one of ${condition.values.join(", ")}`;
  const ends = [
    condition.min === null ? null : `at least ${shown(condition.min)}`,
    condition.max === null ? null : `at most ${shown(condition.max)}`,
  ].filter(Boolean);
  return `${path} is ${ends.join(" and ")}`;
}

/** The requirement in words: only declared values, never an observed one. */
export function describeRequirement({
  agent,
  verdicts,
  since,
  where,
  subject,
}: Requirement) {
  const parts = [`${agent} with ${verdicts.join(" or ")}`];
  if (where?.length)
    parts.push(`where ${where.map(describeCondition).join(" and ")}`);
  if (since.length)
    parts.push(`after the last change or ${since.join(" or ")} work`);
  if (subject === "revision") parts.push("on the current revision");
  return parts.join(" ");
}

/** The latest finished step of the requirement's agent, if any. */
export function lastFinished(requirement: Requirement, events: RunEvent[]) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "step.finished" && event.agent === requirement.agent)
      return event;
  }
  return null;
}
