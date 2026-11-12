// What happened in a run, and what gates and budgets make of it. Pure: the
// integration records the history and passes it in with every decision.
import { z } from "zod";
import {
  effects,
  runName,
  verdict,
  type PolicyBudget,
  type PolicyGate,
  type Requirement,
} from "./policies.ts";

const stepId = z.string().min(1).max(200);
const at = z.iso.datetime({ offset: true });

export { agentName } from "./names.ts";

/** The name actions outside any step are recorded under. */
export const MAIN_AGENT = "main";

const usage = z
  .object({
    tokens: z.number().nonnegative().finite().optional(),
    usd: z.number().nonnegative().finite().optional(),
  })
  .strict();

export const runEvent = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("step.started"),
      step: stepId,
      agent: runName,
      at,
    })
    .strict(),
  z
    .object({
      type: z.literal("step.finished"),
      step: stepId,
      agent: runName,
      at,
      verdict: verdict.nullable(),
      findings: z.array(verdict).max(50),
      usage,
    })
    .strict(),
  z
    .object({
      type: z.literal("action"),
      step: stepId.nullable(),
      agent: runName,
      at,
      tool: z.string().min(1).max(64),
      operation: z.string().min(1).max(128),
      outcome: z.enum([...effects, "none"]),
      /** It changed things and went ahead: see `isChange`. Missing means no. */
      change: z.boolean().optional(),
    })
    .strict(),
]);
export type RunEvent = z.infer<typeof runEvent>;

/** The run an action belongs to, in recorded order, and the step taking it. */
export const runContext = z
  .object({
    run: z.string().min(1).max(200),
    step: z.object({ id: stepId, agent: runName }).strict().nullable(),
    events: z.array(runEvent).max(20_000),
  })
  .strict();
export type RunContext = z.infer<typeof runContext>;

/**
 * Whether an event changed the work under review. Agents the gate itself
 * waits for check the work: their commands (running tests, say) are how they
 * check it, so only their file edits count. Anyone else's change counts.
 */
function changedWork(
  event: RunEvent,
  requirement: Requirement,
  checkers: ReadonlySet<string>,
) {
  if (event.type !== "action" || event.change !== true) return false;
  if (event.agent === requirement.agent) return false;
  return !checkers.has(event.agent) || event.tool === "files";
}

/**
 * The last work a requirement must come after, or -1: anything an agent in
 * `since` did (started, acted or finished), or a change by another agent.
 * Without `since`, nothing.
 */
function lastWorkBefore(
  requirement: Requirement,
  events: RunEvent[],
  checkers: ReadonlySet<string>,
) {
  if (!requirement.since.length) return -1;
  const named = new Set(requirement.since);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event) continue;
    if (named.has(event.agent)) return index;
    if (changedWork(event, requirement, checkers)) return index;
  }
  return -1;
}

/**
 * Met by a step of that agent that started and finished after the latest
 * work, with an accepted verdict. A step that was already running when the
 * work happened saw only part of it, and a finish with no recorded start
 * can't show when the step began, so neither meets it.
 */
export function requirementMet(
  requirement: Requirement,
  events: RunEvent[],
  checkers: ReadonlySet<string> = new Set([requirement.agent]),
) {
  const after = lastWorkBefore(requirement, events, checkers);
  const startedAfter = new Set<string>();
  for (let index = after + 1; index < events.length; index += 1) {
    const event = events[index];
    if (event?.agent !== requirement.agent) continue;
    if (event.type === "step.started") startedAfter.add(event.step);
    if (
      event.type === "step.finished" &&
      startedAfter.has(event.step) &&
      event.verdict !== null &&
      requirement.verdicts.includes(event.verdict)
    )
      return true;
  }
  return false;
}

/** The requirements of a gate that the run has not met. No run meets none. */
export function unmetRequirements(gate: PolicyGate, run: RunContext | null) {
  const checkers = new Set(gate.requires.map(({ agent }) => agent));
  return gate.requires.filter(
    (requirement) => !run || !requirementMet(requirement, run.events, checkers),
  );
}

export type BudgetState = {
  id: string;
  name: string;
  metric: PolicyBudget["metric"];
  used: number;
  limit: number;
  /** `no_run`: the action has no run to count in, so the budget holds it. */
  state: "ok" | "warn" | "over" | "no_run";
  effect: PolicyBudget["effect"];
};

const stepOf = (event: RunEvent) => event.step;

/** Whether this budget covers the action being decided, and what it counts. */
function inScope(budget: PolicyBudget, run: RunContext) {
  const agent = run.step?.agent ?? MAIN_AGENT;
  if (budget.agent !== null && budget.agent !== agent) return null;
  const step = run.step?.id ?? null;
  return (event: RunEvent) =>
    (budget.per === "run" || stepOf(event) === step) &&
    (budget.agent === null || event.agent === budget.agent);
}

/**
 * How much of a budget the run has used. A tool call limit counts the action
 * being decided too, so a limit of 60 allows the 60th call and holds the 61st.
 * With no run there is nothing to count against, so a budget that covers the
 * action holds it, as a gate with no history does.
 */
export function budgetState(
  budget: PolicyBudget,
  run: RunContext | null,
): BudgetState | null {
  if (!run) return budgetWithoutRun(budget);
  const counts = inScope(budget, run);
  if (!counts) return null;
  const events = run.events.filter(counts);
  const { metric } = budget;
  const used =
    metric === "tool_calls"
      ? events.filter((event) => event.type === "action").length + 1
      : events.reduce(
          (sum, event) =>
            event.type === "step.finished"
              ? sum + (event.usage[metric] ?? 0)
              : sum,
          0,
        );
  const over =
    budget.metric === "tool_calls" ? used > budget.limit : used >= budget.limit;
  const warn = budget.warnAt !== null && used >= budget.warnAt;
  return {
    id: budget.id,
    name: budget.name,
    metric: budget.metric,
    used,
    limit: budget.limit,
    state: over ? "over" : warn ? "warn" : "ok",
    effect: budget.effect,
  };
}

/** Without a run the action is the main agent's, outside any step. */
function budgetWithoutRun(budget: PolicyBudget): BudgetState | null {
  if (budget.agent !== null && budget.agent !== MAIN_AGENT) return null;
  return {
    id: budget.id,
    name: budget.name,
    metric: budget.metric,
    used: 0,
    limit: budget.limit,
    state: "no_run",
    effect: budget.effect,
  };
}

const describeRequirement = ({ agent, verdicts, since }: Requirement) =>
  `${agent} with ${verdicts.join(" or ")}${since.length ? ` after the last change or ${since.join(" or ")} work` : ""}`;

export function explainGate(gate: PolicyGate, missing: Requirement[]) {
  return `Gate ${gate.id} needs ${missing.map(describeRequirement).join("; ")}.`;
}

export function explainBudget(budget: BudgetState) {
  const unit =
    budget.metric === "usd" ? "USD" : budget.metric.replace("_", " ");
  if (budget.state === "no_run")
    return `Budget ${budget.id} needs a run to count ${unit}, and this action has none.`;
  return `Budget ${budget.id} is at ${budget.used} of ${budget.limit} ${unit}.`;
}
