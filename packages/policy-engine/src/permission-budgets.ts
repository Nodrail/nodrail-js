// What an edited budget does to permissions. A budget only ever holds actions
// back, so a higher limit loosens it and a wider reach tightens it.
import type { Aspect } from "./permission-aspects.ts";
import type { PolicyBudget } from "./policies.ts";

export const describeBudget = (budget: PolicyBudget) =>
  `${budget.limit} ${budget.metric} per ${budget.per}`;

function limitAspect(before: PolicyBudget, after: PolicyBudget): Aspect[] {
  const text = `limit ${describeBudget(before)} → ${describeBudget(after)}`;
  // Different measures can't be compared, so the limit tells nothing on its own.
  if (before.metric !== after.metric) return [{ impact: "changed", text }];
  const aspects: Aspect[] = [];
  if (after.limit > before.limit)
    aspects.push({ impact: "loosened", warning: true, text });
  if (after.limit < before.limit) aspects.push({ impact: "tightened", text });
  // A run counts every step's calls, so per run reaches the limit no sooner than per step.
  if (after.per !== before.per)
    aspects.push({
      impact: after.per === "run" ? "tightened" : "loosened",
      warning: after.per !== "run",
      text,
    });
  return aspects;
}

/** No agent means every agent's work counts, which reaches the limit sooner. */
function agentAspect(before: PolicyBudget, after: PolicyBudget): Aspect[] {
  if (before.agent === after.agent) return [];
  const text = `agent ${before.agent ?? "all"} → ${after.agent ?? "all"}`;
  if (after.agent === null) return [{ impact: "tightened", text }];
  if (before.agent === null)
    return [{ impact: "loosened", warning: true, text }];
  return [{ impact: "changed", text }];
}

function effectAspect(before: PolicyBudget, after: PolicyBudget): Aspect[] {
  if (before.effect === after.effect) return [];
  const text = `otherwise ${before.effect.replace("_", " ")} → ${after.effect.replace("_", " ")}`;
  return [
    {
      impact: after.effect === "deny" ? "tightened" : "loosened",
      warning: after.effect !== "deny",
      text,
    },
  ];
}

/** A warning and a name decide nothing, so they never set the impact. */
function noticeAspects(before: PolicyBudget, after: PolicyBudget): Aspect[] {
  const aspects: Aspect[] = [];
  if (before.warnAt !== after.warnAt)
    aspects.push({
      impact: null,
      text: `warn at ${before.warnAt ?? "never"} → ${after.warnAt ?? "never"}`,
    });
  if (before.name !== after.name)
    aspects.push({
      impact: null,
      text: `renamed "${before.name}" → "${after.name}"`,
    });
  return aspects;
}

/** Every aspect of a budget kept under the same id that changed. */
export function budgetAspects(before: PolicyBudget, after: PolicyBudget) {
  return [
    ...limitAspect(before, after),
    ...agentAspect(before, after),
    ...effectAspect(before, after),
    ...noticeAspects(before, after),
  ];
}
