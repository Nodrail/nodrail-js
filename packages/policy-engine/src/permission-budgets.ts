// What an edited budget does to permissions. A budget only ever holds actions
// back, so a higher limit loosens it and a wider reach tightens it. Numeric
// budgets (version 4) also have a window, a reach (`across`) and a source.
import type { Aspect } from "./permission-aspects.ts";
import {
  BUDGET_LABELS,
  budgetLabel,
  type EvidenceNeed,
  type NumericBudget,
  type PolicyBudget,
} from "./policies.ts";

/** A budget of either kind. */
export type AnyBudget = PolicyBudget | NumericBudget;

const isNumeric = (budget: AnyBudget): budget is NumericBudget =>
  "measure" in budget;

function counted(budget: NumericBudget) {
  const { measure } = budget;
  if (measure.kind === "count")
    return `${measure.tool}.${measure.operation} calls`;
  if (measure.kind === "sum")
    return `${budget.unit} of ${measure.tool}.${measure.operation} ${measure.path}`;
  return "measured tokens";
}

/** The window as people read it: per run, per day in Europe/Madrid. */
const windowText = (budget: NumericBudget) =>
  budget.per === "day" ? `per day in ${budget.timezone}` : `per ${budget.per}`;

export const describeBudget = (budget: AnyBudget) =>
  isNumeric(budget)
    ? `${budget.limit} ${counted(budget)} ${windowText(budget)}${budget.across === "environment" ? " across the environment" : ""} (${BUDGET_LABELS[budget.label]})`
    : `${budget.limit} ${budget.metric} per ${budget.per}`;

/** Where a budget's limit counts, from narrowest to widest. */
const PER = { step: 0, run: 1, day: 2 } as const;

function limitAspect(before: AnyBudget, after: AnyBudget): Aspect[] {
  const text = `limit ${describeBudget(before)} → ${describeBudget(after)}`;
  // Different measures can't be compared, so the limit tells nothing on its own.
  const same = isNumeric(before)
    ? isNumeric(after) &&
      JSON.stringify(before.measure) === JSON.stringify(after.measure) &&
      before.unit === after.unit
    : !isNumeric(after) && before.metric === after.metric;
  if (!same) return [{ impact: "changed", text }];
  const aspects: Aspect[] = [];
  if (after.limit > before.limit)
    aspects.push({ impact: "loosened", warning: true, text });
  if (after.limit < before.limit) aspects.push({ impact: "tightened", text });
  // A run counts every step's calls, so per run reaches the limit no sooner than per step.
  if (after.per !== before.per) {
    // A day and a run aren't nested: a day can hold many runs, or part of one.
    const comparable = after.per !== "day" && before.per !== "day";
    aspects.push(
      comparable
        ? {
            impact: after.per === "run" ? "tightened" : "loosened",
            warning: after.per !== "run",
            text,
          }
        : { impact: "changed", warning: true, text },
    );
  }
  return aspects;
}

/** A shared reach counts every run's calls; the window's zone moves its reset. */
function reachAspects(before: AnyBudget, after: AnyBudget): Aspect[] {
  if (!isNumeric(before) || !isNumeric(after)) return [];
  const aspects: Aspect[] = [];
  if (before.across !== after.across)
    aspects.push({
      impact: after.across === "environment" ? "tightened" : "loosened",
      warning: after.across !== "environment",
      text: `across ${before.across} → ${after.across}`,
    });
  if (before.timezone !== after.timezone && PER[after.per] === PER.day)
    aspects.push({
      impact: "changed",
      text: `day in ${before.timezone ?? "none"} → ${after.timezone ?? "none"}`,
    });
  return aspects;
}

/** A hard allowance becoming a measured or agent-reported limit is weaker. */
function sourceAspect(before: AnyBudget, after: AnyBudget): Aspect[] {
  const was = budgetLabel(before);
  const is = budgetLabel(after);
  if (was === is) return [];
  const strength = {
    "enforced-allowance": 2,
    "measured-usage": 1,
    "agent-reported-usage": 0,
  } as const;
  return [
    {
      impact: strength[is] > strength[was] ? "tightened" : "loosened",
      warning: strength[is] < strength[was],
      text: `source ${BUDGET_LABELS[was]} → ${BUDGET_LABELS[is]}`,
    },
  ];
}

/** No agent means every agent's work counts, which reaches the limit sooner. */
function agentAspect(before: AnyBudget, after: AnyBudget): Aspect[] {
  if (before.agent === after.agent) return [];
  const text = `agent ${before.agent ?? "all"} → ${after.agent ?? "all"}`;
  if (after.agent === null) return [{ impact: "tightened", text }];
  if (before.agent === null)
    return [{ impact: "loosened", warning: true, text }];
  return [{ impact: "changed", text }];
}

/** A warning and a name decide nothing, so they never set the impact. */
function noticeAspects(before: AnyBudget, after: AnyBudget): Aspect[] {
  const aspects: Aspect[] = [];
  const warnOf = (budget: AnyBudget) =>
    isNumeric(budget) ? null : budget.warnAt;
  if (warnOf(before) !== warnOf(after))
    aspects.push({
      impact: null,
      text: `warn at ${warnOf(before) ?? "never"} → ${warnOf(after) ?? "never"}`,
    });
  if (before.name !== after.name)
    aspects.push({
      impact: null,
      text: `renamed "${before.name}" → "${after.name}"`,
    });
  return aspects;
}

/** Every aspect of a budget kept under the same id that changed. */
export function budgetAspects(before: AnyBudget, after: AnyBudget) {
  return [
    ...limitAspect(before, after),
    ...reachAspects(before, after),
    ...sourceAspect(before, after),
    ...agentAspect(before, after),
    ...noticeAspects(before, after),
  ];
}

const AUTHORITY = {
  "agent-reported": 0,
  "runtime-observed": 1,
  "externally-verified": 2,
} as const;

export const describeEvidenceNeed = (need: EvidenceNeed) =>
  `${need.evidence} (${need.authority}) on the current revision`;

/** A gate's evidence requirements, before and after, by evidence name. */
export function evidenceAspects(
  before: readonly EvidenceNeed[],
  after: readonly EvidenceNeed[],
): Aspect[] {
  const aspects: Aspect[] = [];
  const was = new Map(before.map((need) => [need.evidence, need]));
  const is = new Map(after.map((need) => [need.evidence, need]));
  for (const [name, need] of is) {
    const old = was.get(name);
    if (!old) {
      aspects.push({
        impact: "tightened",
        text: `now needs ${describeEvidenceNeed(need)}`,
      });
      continue;
    }
    if (AUTHORITY[need.authority] !== AUTHORITY[old.authority])
      aspects.push({
        impact:
          AUTHORITY[need.authority] > AUTHORITY[old.authority]
            ? "tightened"
            : "loosened",
        warning: AUTHORITY[need.authority] < AUTHORITY[old.authority],
        text: `${name} authority ${old.authority} → ${need.authority}`,
      });
    if (
      old.contract !== need.contract ||
      JSON.stringify(old.where) !== JSON.stringify(need.where)
    )
      aspects.push({
        impact: "changed",
        text: `${name} conditions or contract changed`,
      });
  }
  for (const [name, need] of was)
    if (!is.has(name))
      aspects.push({
        impact: "loosened",
        warning: true,
        text: `no longer needs ${describeEvidenceNeed(need)}`,
      });
  return aspects;
}
