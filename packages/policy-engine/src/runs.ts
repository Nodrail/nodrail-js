// What happened in a run, and what gates and budgets make of it. Pure: the
// integration records the history and passes it in with every decision.
import { z } from "zod";
import {
  declaredGateId,
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
import {
  describeRequirement,
  lastFinished,
  shortfall,
  type Subject,
} from "./run-receipts.ts";
export type { Subject } from "./run-receipts.ts";

/** The name actions outside any step are recorded under. */
export const MAIN_AGENT = "main";

const usage = z
  .object({
    tokens: z.number().nonnegative().finite().optional(),
    usd: z.number().nonnegative().finite().optional(),
  })
  .strict();

/**
 * A receipt read against the agent's declared contract (engine version 4).
 * The full value stays in the local ledger; what leaves the machine is the
 * state, the contract digest and the findings count. Issues name a path and
 * a code, never a value.
 */
/** Issues name a path and a code, never a value. */
export const issueList = z
  .array(
    z.object({ path: z.string().max(400), code: z.string().max(40) }).strict(),
  )
  .max(20);

const receiptRecord = z
  .object({
    name: z.string().min(1).max(63),
    contract: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    state: z.enum(["valid", "invalid", "missing"]),
    /** Where it was captured: the stop event, or the hand-back tool call. */
    via: z.enum(["stop", "handback"]),
    value: z.record(z.string(), z.unknown()).nullable(),
    findings: z.number().int().min(0).nullable(),
    issues: issueList,
    reason: z.string().max(1000).nullable(),
  })
  .strict();
export type ReceiptRecord = z.infer<typeof receiptRecord>;

const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
/** `host:<the host's id for the call>`, stable across a host's re-deliveries. */
const budgetKey = z.string().regex(/^[a-z][a-z0-9-]{0,31}:[\x21-\x7e]{1,200}$/);
/** Whole minor units; a total that could overflow is never trusted. */
const amount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/**
 * A mediated connection call's input (S03, S06) or result (S04) checked
 * against its declared contract where the call ran. `values` is the
 * reporting projection of a valid value, never the full one; issues name a
 * path and a code. `unsupported`: the result couldn't be read as a value at
 * all (`reason` says how), which is never valid.
 */
export const contractCheck = z
  .object({
    surface: z.enum(["S03", "S04", "S06"]),
    name: z
      .string()
      .regex(/^(?:input|output):[a-z0-9_-]{1,64}\.[a-z0-9_-]{1,128}$/),
    shape: z.string().min(1).max(63),
    contract: digest,
    projection: digest,
    state: z.enum(["valid", "invalid", "unsupported"]),
    at: z.literal("local"),
    issues: issueList,
    reason: z.enum(["not-json", "content-form"]).nullable(),
    values: z.record(z.string(), z.unknown()).nullable(),
  })
  .strict()
  .refine((check) => check.state === "valid" || check.values === null, {
    path: ["values"],
    message: "Only a valid value has values",
  });
export type ContractCheck = z.infer<typeof contractCheck>;

/**
 * A call a connector mediated (runtime-observed): what its input and result
 * checks said, and what happened at the provider. Execution and result
 * validity stay apart: a provider can succeed and return an invalid result.
 * `delivered`: whether the result reached the agent as usable.
 */
export const mediatedCall = z
  .object({
    type: z.literal("connection.call"),
    /** Stable across retries: the connector's id for this call. */
    event: z.uuid(),
    connection: z.string().regex(/^[a-z0-9_-]{1,64}$/),
    operation: z.string().regex(/^[a-z0-9_-]{1,128}$/),
    occurred_at: at,
    producer: z
      .object({
        class: z.literal("runtime-observed"),
        id: z.string().regex(/^connector:[a-z0-9_-]{1,64}$/),
      })
      .strict(),
    input: contractCheck.nullable(),
    /**
     * `fingerprint` of the call's arguments: the `input_sha256` the host
     * hook gave the same call, which joins it to the call's reservation.
     */
    input_sha256: digest.optional(),
    execution: z.enum(["succeeded", "failed", "not-called", "unknown"]),
    result: contractCheck.nullable(),
    delivered: z.boolean(),
  })
  .strict()
  .refine(
    (call) =>
      call.input?.state !== "invalid" || call.execution === "not-called",
    {
      path: ["execution"],
      message: "An invalid input never reaches the provider",
    },
  );
export type MediatedCall = z.infer<typeof mediatedCall>;

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
      receipt: receiptRecord.optional(),
      /** The revision the work was at when the step finished, when a gate needs it. */
      subject: z.string().max(200).nullable().optional(),
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
      /** The host's id for the call (`host:tool_use_id`), when it gave one. */
      key: budgetKey.optional(),
    })
    .strict(),
  /**
   * A call a connector mediated, as it recorded it, placed in the run like
   * an action: at the call's time, under the step and agent that made it
   * when the connector knows them, else the main agent with no step.
   */
  z
    .object({
      type: z.literal("connection.call"),
      step: stepId.nullable(),
      agent: runName,
      at,
      call: mediatedCall,
    })
    .strict(),
  /**
   * An amount a numeric budget set aside for a call that went ahead
   * (admission): counted until it is settled released.
   */
  z
    .object({
      type: z.literal("budget.reserved"),
      step: stepId.nullable(),
      agent: runName,
      at,
      key: budgetKey,
      budget: z.string().min(1).max(63),
      amount: amount,
      unit: z.string().max(32),
      tool: z.string().min(1).max(64),
      operation: z.string().min(1).max(128),
      input_sha256: digest.nullable(),
    })
    .strict(),
  /**
   * What became of a call's reservations: `consumed` (it ran), `released`
   * (it never reached the provider, or the provider said it failed) or
   * `unknown` (counted until a person reconciles it). The runtime's first
   * word stands; a person's later one replaces it.
   */
  z
    .object({
      type: z.literal("budget.settled"),
      step: stepId.nullable(),
      agent: runName,
      at,
      key: budgetKey,
      state: z.enum(["consumed", "released", "unknown"]),
      by: z.enum(["runtime", "person"]),
      note: z.string().max(500).optional(),
    })
    .strict(),
  /**
   * An amount the runtime measured after a call: a result's integer path
   * (`result.<path>`) or a subagent's tokens (`tokens`). Null when there was
   * no reading, which is unknown, never zero.
   */
  z
    .object({
      type: z.literal("budget.measured"),
      step: stepId.nullable(),
      agent: runName,
      at,
      key: budgetKey,
      tool: z.string().min(1).max(64),
      operation: z.string().min(1).max(128),
      path: z
        .string()
        .regex(/^(?:tokens|result(?:\.[a-z][a-z0-9_]{0,62}){1,4})$/),
      amount: amount.nullable(),
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
    // A budget's bookkeeping is about a call already in the run, not new work.
    if (!event || event.type.startsWith("budget.")) continue;
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
  subject: Subject | null = null,
) {
  const after = lastWorkBefore(requirement, events, checkers);
  const startedAfter = new Set<string>();
  // R375: only the agent's latest finished step counts, per revision when
  // the requirement is about one: a later receipt that fails closes the
  // gate an earlier one opened.
  let now: string | null | undefined;
  const sameRevision = (said: string | null | undefined) => {
    if (requirement.subject !== "revision" || !said) return true;
    if (now === undefined) now = subject?.() ?? null;
    return now === null || said === now;
  };
  let latest: Extract<RunEvent, { type: "step.finished" }> | null = null;
  for (let index = after + 1; index < events.length; index += 1) {
    const event = events[index];
    if (event?.agent !== requirement.agent) continue;
    if (event.type === "step.started") startedAfter.add(event.step);
    if (event.type === "step.finished" && sameRevision(event.subject))
      latest = event;
  }
  return (
    latest !== null &&
    startedAfter.has(latest.step) &&
    shortfall(latest, requirement, subject) === null
  );
}

/**
 * The requirements of a gate that the run has not met. No run meets none.
 * `subject` reads the current revision, for requirements that need it.
 */
export function unmetRequirements(
  gate: PolicyGate,
  run: RunContext | null,
  subject: Subject | null = null,
) {
  const checkers = new Set(gate.requires.map(({ agent }) => agent));
  return gate.requires.filter(
    (requirement) =>
      !run || !requirementMet(requirement, run.events, checkers, subject),
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

/**
 * Why a gate holds: each unmet requirement in words and, from the run, why
 * the agent's last finished step falls short of it. Paths and codes only,
 * never a receipt's values.
 */
export function explainGate(
  gate: PolicyGate,
  missing: Requirement[],
  run: RunContext | null = null,
  subject: Subject | null = null,
) {
  const said = missing.map((requirement) => {
    const last = run ? lastFinished(requirement, run.events) : null;
    const why = last ? shortfall(last, requirement, subject) : null;
    return `${describeRequirement(requirement)}${why ? ` (${why})` : ""}`;
  });
  return `Gate ${declaredGateId(gate)} needs ${said.join("; ")}.`;
}

export function explainBudget(budget: BudgetState) {
  const unit =
    budget.metric === "usd" ? "USD" : budget.metric.replace("_", " ");
  if (budget.state === "no_run")
    return `Budget ${budget.id} needs a run to count ${unit}, and this action has none.`;
  return `Budget ${budget.id} is at ${budget.used} of ${budget.limit} ${unit}.`;
}
