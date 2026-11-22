// What a mediated call means for a budget (Wave 3, DC-03.3, connector side):
// the integer `result.` values a budget sums, read from the validated result
// only, and how the call's execution settles a reservation. Nothing here
// reserves or writes a budget: the engine owns that, and calls this through
// `BudgetSettler`. A reading that can't be trusted is null, never 0, so an
// unknown amount holds (fail closed) instead of counting as nothing.
import {
  valueAt,
  type ResolvedProperty,
  type ResolvedShape,
} from "@nodrail/policy-engine/contracts";
import type { CallDetails, Execution, MediatedCall } from "./mediate.ts";

/**
 * One `sum` a budget takes from a connection's results: `path` is
 * `result.<field>[.<field>…]`. Until the engine compiles Wave 3 budgets this
 * is the connector's own view of the grammar's `sum: {tool, operation, path}`.
 */
export type SummedPath = {
  connection: string;
  operation: string;
  path: string;
};

/** Why a summed path has no reading. Codes only, never a value. */
export type MeasureGap =
  /** No validated result: the output is undeclared, invalid or unreadable. */
  | "no-result"
  /** The output contract doesn't declare the path as an unclassified integer. */
  | "undeclared"
  /** The result leaves the (optional) field out. */
  | "missing"
  /** Not a safe, non-negative integer, so it can't add to a total. */
  | "not-integer";

/** One reading: an amount in the field's minor unit, or null with its gap. */
export type Measurement =
  | { path: string; value: number; gap: null }
  | { path: string; value: null; gap: MeasureGap };

const RESULT = /^result\.([a-z0-9_]+(?:\.[a-z0-9_]+)*)$/;

/**
 * The declared property at a path, when every step is an unclassified
 * object and the last is an unclassified integer: a secret or personal
 * amount is never read into a total that leaves the machine.
 */
function integerAt(shape: ResolvedShape, fields: string[]) {
  let properties: Record<string, ResolvedProperty> = shape.properties;
  for (const [index, field] of fields.entries()) {
    const property = Object.hasOwn(properties, field)
      ? properties[field]
      : undefined;
    if (!property || property.classification !== null) return false;
    if (index === fields.length - 1) return property.type === "integer";
    if (property.type !== "object") return false;
    properties = property.properties;
  }
  return false;
}

/**
 * The amounts a call's result holds for the budgets that sum this
 * operation, in the order the sums are given.
 */
export function measureResult(
  sums: readonly SummedPath[],
  call: {
    connection: string;
    operation: string;
    /** The declared output, null when the operation declares none. */
    shape: ResolvedShape | null;
    /** The validated result value; undefined when there is none. */
    result: unknown;
  },
): Measurement[] {
  const { connection, operation, shape, result } = call;
  return sums
    .filter(
      (sum) => sum.connection === connection && sum.operation === operation,
    )
    .map(({ path }): Measurement => {
      const fields = RESULT.exec(path)?.[1]?.split(".");
      if (!fields || !shape || !integerAt(shape, fields))
        return { path, value: null, gap: "undeclared" };
      if (result === undefined) return { path, value: null, gap: "no-result" };
      const value = valueAt(result, fields);
      if (value === undefined) return { path, value: null, gap: "missing" };
      if (
        typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value < 0
      )
        return { path, value: null, gap: "not-integer" };
      return { path, value, gap: null };
    });
}

/**
 * How a call settles its reservation (WAVE3-DESIGN §3.3): released only
 * when the provider never had it (`not-called`, which includes input the
 * contract refused) or said it failed; `unknown` stays counted until a
 * person reconciles it; a success is consumed, whatever its result says.
 */
export type Settlement = "consumed" | "released" | "unknown";

export function settlementOf(execution: Execution): Settlement {
  switch (execution) {
    case "succeeded":
      return "consumed";
    case "failed":
    case "not-called":
      return "released";
    case "unknown":
      return "unknown";
  }
}

/**
 * A call as a budget settles it. The reservation it settles is the oldest
 * open one with the same connection, operation and `input_sha256`, which is
 * the digest the host hook gave the same call when it reserved.
 */
export type SettledCall = {
  event: string;
  connection: string;
  operation: string;
  input_sha256: string;
  settlement: Settlement;
  /** Only for a consumed call; a gap holds the budget as unknown. */
  measured: Measurement[];
};

export const settledCall = (
  call: MediatedCall,
  details: CallDetails,
): SettledCall => {
  const settlement = settlementOf(call.execution);
  return {
    event: call.event,
    connection: call.connection,
    operation: call.operation,
    input_sha256: details.input_sha256,
    settlement,
    measured: settlement === "consumed" ? details.measured : [],
  };
};

/**
 * Settles a call's reservation, called under the run's lock right after the
 * call is in the ledger. FOLLOW-UP (engine lane E, `budget-ledger.ts`): the
 * engine's reserve/settle isn't on main yet; its `budget.settled` writer is
 * what plugs in here.
 */
export type BudgetSettler = (call: SettledCall) => void;
