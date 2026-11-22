// Numeric budgets (C03) on the local run ledger: what a budget has used in
// its window, whether a call fits, the reservation a call that goes ahead
// sets aside, and how it settles. Pure over the run's events; the hook
// records what these return while it holds the run's lock, so two calls
// can't both take a budget's last slot.
//
// - Admission (`count`, `sum` of an `input.` path): the amount is known
//   before the call and reserved. Reserved, consumed and unknown amounts all
//   count; only a known failure (mediated `failed`/`not-called`) releases.
// - Measured (`sum` of a `result.` path, `tokens`): known only after the
//   call. It stops further work at the limit; a step with no reading is
//   unknown, and unknown holds.
// - `across: environment` needs the shared online authority: locally it
//   holds every call it covers.
import type { ContractValues } from "./evaluator.ts";
import { dayWindow } from "./budget-windows.ts";
import {
  BUDGET_LABELS,
  type BudgetLabel,
  type NumericBudget,
} from "./policies.ts";
import type { RunContext, RunEvent } from "./runs.ts";
import { valueAt } from "./shapes/validate.ts";

/** The name actions outside any step are recorded under (as runs.ts). */
const MAIN = "main";

type Reserved = Extract<RunEvent, { type: "budget.reserved" }>;
type Settled = Extract<RunEvent, { type: "budget.settled" }>;
export type Settlement = Settled["state"];

/** The call being decided, as a budget sees it. */
export type BudgetCall = {
  tool: string;
  operation: string;
  /** Its validated input, which a `sum` of an `input.` path reads. */
  values: ContractValues | null;
};

/**
 * Who counts numeric budgets for this decision. `local`: this run's ledger
 * (the hook). Without one, a numeric budget that covers the call holds it:
 * nothing here can count it.
 */
export type BudgetAuthority = "local" | null;

export type LimitState = {
  id: string;
  name: string;
  label: BudgetLabel;
  unit: string;
  limit: number;
  /** Consumed, reserved and unknown amounts in the window, or measured ones. */
  used: number;
  /** Of `used`: reservations not settled yet. */
  reserved: number;
  /** Of `used`: reservations settled unknown. */
  unknown: number;
  /** Measured steps without a reading. */
  unread: number;
  /** What this call adds (admission); null when it can't be known before. */
  amount: number | null;
  /**
   * `ok`, `over`; `unknown`: this call's amount, or a measured step, is
   * unknown; `shared`: only the online authority can count it; `no_run`:
   * no run to count in; `uncounted`: no ledger counts it here.
   */
  state: "ok" | "over" | "unknown" | "shared" | "no_run" | "uncounted";
  effect: NumericBudget["effect"];
  /** When a day window resets, ISO; null for step and run. */
  resets: string | null;
};

/** Whether a budget covers this call at all. */
export function covers(budget: NumericBudget, call: BudgetCall, agent: string) {
  if (budget.agent !== null && budget.agent !== agent) return false;
  const { measure } = budget;
  if (measure.kind === "tokens")
    return (
      (call.tool === "claude-code" || call.tool === "codex") &&
      call.operation === "agent"
    );
  return measure.tool === call.tool && measure.operation === call.operation;
}

/** The amount a call adds before it runs, or null when it can't be known. */
function admissionAmount(budget: NumericBudget, call: BudgetCall) {
  const { measure } = budget;
  if (measure.kind === "count") return 1;
  if (measure.kind !== "sum") return null;
  const value = valueAt(call.values?.input, measure.path.split(".").slice(1));
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

/** The settled state of each key: a person's last word, else the runtime's first. */
export function settlements(events: readonly RunEvent[]) {
  const runtime = new Map<string, Settlement>();
  const person = new Map<string, Settlement>();
  for (const event of events) {
    if (event.type !== "budget.settled") continue;
    if (event.by === "person") person.set(event.key, event.state);
    else if (!runtime.has(event.key)) runtime.set(event.key, event.state);
  }
  return (key: string) => person.get(key) ?? runtime.get(key) ?? null;
}

/** The events a budget counts: its agent, its step or the whole run, its day. */
function windowed(
  budget: NumericBudget,
  run: RunContext,
  now: Date,
): (event: RunEvent) => boolean {
  const step = run.step?.id ?? null;
  const day = budget.timezone ? dayWindow(now, budget.timezone) : null;
  return (event) => {
    if (budget.agent !== null && event.agent !== budget.agent) return false;
    if (budget.per === "step" && event.step !== step) return false;
    if (day) {
      const at = Date.parse(event.at);
      if (at < day.start.getTime() || at >= day.end.getTime()) return false;
    }
    return true;
  };
}

const safeAdd = (a: number, b: number) => {
  const sum = a + b;
  return Number.isSafeInteger(sum) ? sum : Number.POSITIVE_INFINITY;
};

function base(budget: NumericBudget, now: Date) {
  return {
    id: budget.id,
    name: budget.name,
    label: budget.label,
    unit: budget.unit,
    limit: budget.limit,
    used: 0,
    reserved: 0,
    unknown: 0,
    unread: 0,
    amount: null,
    effect: budget.effect,
    resets: budget.timezone
      ? dayWindow(now, budget.timezone).end.toISOString()
      : null,
  };
}

function admission(
  budget: NumericBudget,
  events: RunEvent[],
  call: BudgetCall,
  now: Date,
): LimitState {
  const settled = settlements(events);
  let used = 0;
  let reserved = 0;
  let unknown = 0;
  for (const event of events) {
    if (event.type !== "budget.reserved" || event.budget !== budget.id)
      continue;
    const state = settled(event.key);
    if (state === "released") continue;
    used = safeAdd(used, event.amount);
    if (state === null) reserved = safeAdd(reserved, event.amount);
    if (state === "unknown") unknown = safeAdd(unknown, event.amount);
  }
  const amount = admissionAmount(budget, call);
  const total = amount === null ? used : safeAdd(used, amount);
  return {
    ...base(budget, now),
    used,
    reserved,
    unknown,
    amount,
    // A total past safe integers is unknown, and holds.
    state:
      amount === null || !Number.isFinite(total)
        ? "unknown"
        : total > budget.limit
          ? "over"
          : "ok",
  };
}

function measured(
  budget: NumericBudget,
  events: RunEvent[],
  now: Date,
): LimitState {
  const { measure } = budget;
  const path = measure.kind === "sum" ? measure.path : "tokens";
  let used = 0;
  let unread = 0;
  for (const event of events) {
    if (event.type !== "budget.measured" || event.path !== path) continue;
    if (
      measure.kind === "sum" &&
      (event.tool !== measure.tool || event.operation !== measure.operation)
    )
      continue;
    if (event.amount === null) unread += 1;
    else used = safeAdd(used, event.amount);
  }
  return {
    ...base(budget, now),
    used,
    unread,
    state:
      unread > 0 || !Number.isFinite(used)
        ? "unknown"
        : used >= budget.limit
          ? "over"
          : "ok",
  };
}

/**
 * Where a numeric budget stands for this call, or null when it doesn't
 * cover the call. Without a run, or a ledger that counts it, it holds.
 */
export function limitState(
  budget: NumericBudget,
  context: {
    run: RunContext | null;
    call: BudgetCall;
    now: Date;
    authority: BudgetAuthority;
  },
): LimitState | null {
  const { run, call, now, authority } = context;
  const agent = run?.step?.agent ?? MAIN;
  if (!covers(budget, call, agent)) return null;
  if (budget.across === "environment")
    return { ...base(budget, now), state: "shared" };
  if (!authority) return { ...base(budget, now), state: "uncounted" };
  if (!run) return { ...base(budget, now), state: "no_run" };
  const events = run.events.filter(windowed(budget, run, now));
  return budget.source === "admission"
    ? admission(budget, events, call, now)
    : measured(budget, events, now);
}

/** Whether a budget in this state holds the call. */
export const holds = (state: LimitState) => state.state !== "ok";

/** Why a budget holds, or what it stands at: declared numbers only. */
export function explainLimit(state: LimitState) {
  const label = BUDGET_LABELS[state.label].toLowerCase();
  const resets = state.resets ? `; it resets at ${state.resets}` : "";
  switch (state.state) {
    case "shared":
      return `Budget ${state.id} is shared across the environment, and shared budgets are enforced only on a Cloud-managed connection.`;
    case "uncounted":
      return `Budget ${state.id} is counted by the run ledger or Cloud, and neither counts it here.`;
    case "no_run":
      return `Budget ${state.id} needs a run to count ${state.unit}, and this action has none.`;
    case "unknown":
      return state.label === "measured-usage"
        ? `Budget ${state.id} is at ≥ ${state.used} of ${state.limit} ${state.unit}, ${state.unread} step${state.unread === 1 ? "" : "s"} unknown (${label}). Unknown usage holds until a person reconciles it${resets}.`
        : `Budget ${state.id} can't know what this call adds before it runs, so it holds it (${label}).`;
    default:
      return `Budget ${state.id} is at ${state.used} of ${state.limit} ${state.unit} (${label}${state.unknown ? `, ${state.unknown} unknown` : ""})${state.amount !== null && state.state === "over" ? ` and this call needs ${state.amount} more` : ""}${resets}.`;
  }
}

/** The reservations a call that goes ahead sets aside, one per admission budget. */
export function reservationsFor(
  states: readonly LimitState[],
  budgets: readonly NumericBudget[],
  call: {
    key: string;
    tool: string;
    operation: string;
    step: string | null;
    agent: string;
    at: string;
    input_sha256: string | null;
  },
): Reserved[] {
  return states.flatMap((state) => {
    const budget = budgets.find(({ id }) => id === state.id);
    if (budget?.source !== "admission" || state.state !== "ok") return [];
    if (state.amount === null) return [];
    return [
      {
        type: "budget.reserved" as const,
        step: call.step,
        agent: call.agent,
        at: call.at,
        key: call.key,
        budget: state.id,
        amount: state.amount,
        unit: state.unit,
        tool: call.tool,
        operation: call.operation,
        input_sha256: call.input_sha256,
      },
    ];
  });
}

/** Keys with a reservation and no settlement yet, oldest first. */
export function openKeys(events: readonly RunEvent[]) {
  const settled = settlements(events);
  const keys: string[] = [];
  for (const event of events)
    if (
      event.type === "budget.reserved" &&
      settled(event.key) === null &&
      !keys.includes(event.key)
    )
      keys.push(event.key);
  return keys;
}

/**
 * The settlement of `key`, or null when it has no open reservation: a
 * repeated delivery, or a call that reserved nothing, settles nothing.
 */
export function settle(
  events: readonly RunEvent[],
  key: string,
  state: Settlement,
  at: string,
): Settled | null {
  if (!openKeys(events).includes(key)) return null;
  const first = events.find(
    (event): event is Reserved =>
      event.type === "budget.reserved" && event.key === key,
  )!;
  return {
    type: "budget.settled",
    step: first.step,
    agent: first.agent,
    at,
    key,
    state,
    by: "runtime",
  };
}

/**
 * A person's word on a reservation (`nodrail budgets reconcile`): it
 * replaces the runtime's. Null when the key never reserved anything.
 */
export function reconcile(
  events: readonly RunEvent[],
  key: string,
  word: { state: "consumed" | "released"; at: string; note: string },
): Settled | null {
  const { state, at, note } = word;
  const first = events.find(
    (event): event is Reserved =>
      event.type === "budget.reserved" && event.key === key,
  );
  if (!first) return null;
  return {
    type: "budget.settled",
    step: first.step,
    agent: first.agent,
    at,
    key,
    state,
    by: "person",
    note: note.slice(0, 500),
  };
}

/**
 * A mediated call as it settles a budget (the connector's `SettledCall`):
 * succeeded is consumed, failed and not-called are released, unknown stays
 * counted. `measured` holds the `result.` amounts it read, null when none.
 */
export type MediatedSettlement = {
  event: string;
  connection: string;
  operation: string;
  input_sha256: string;
  settlement: Settlement;
  measured: readonly { path: string; value: number | null }[];
};

/**
 * What a mediated call writes to the run: the settlement of the oldest open
 * reservation with the same connection, operation and input digest, and a
 * `budget.measured` for each amount it read. Call it under the run's lock,
 * right after the call is recorded.
 */
export function mediatedSettlement(
  events: readonly RunEvent[],
  call: MediatedSettlement,
  at: string,
): RunEvent[] {
  const open = openKeys(events);
  const reservation = events.find(
    (event): event is Reserved =>
      event.type === "budget.reserved" &&
      open.includes(event.key) &&
      event.tool === call.connection &&
      event.operation === call.operation &&
      event.input_sha256 === call.input_sha256,
  );
  const key = reservation?.key ?? `connector:${call.event}`;
  const out: RunEvent[] = [];
  const settled = reservation && settle(events, key, call.settlement, at);
  if (settled) out.push(settled);
  const step = reservation?.step ?? null;
  const agent = reservation?.agent ?? MAIN;
  for (const { path, value } of call.measured)
    if (/^result(?:\.[a-z][a-z0-9_]{0,62}){1,4}$/.test(path))
      out.push({
        type: "budget.measured",
        step,
        agent,
        at,
        key,
        tool: call.connection,
        operation: call.operation,
        path,
        amount:
          value !== null && Number.isSafeInteger(value) && value >= 0
            ? value
            : null,
      });
  return out;
}

/**
 * The index of the action an earlier delivery of the same call recorded,
 * or -1: a host that delivers a PreToolUse twice gets the same decision,
 * and nothing is reserved or counted twice.
 */
export function earlierDelivery(events: readonly RunEvent[], key: string) {
  return events.findIndex(
    (event) => event.type === "action" && event.key === key,
  );
}
