// Strict validation of a value against a resolved shape, and the condition
// check consumers share. No coercion: "0" is not 0, "false" is not false, and
// a parsed Date is not a date. Issues name a path and a reason, never the
// rejected value.
import { characters, isDate } from "./limits.ts";
import type {
  CompiledCondition,
  ResolvedProperty,
  ResolvedShape,
} from "./types.ts";

export type ValueIssue = { path: string; code: string; message: string };

/** Stops after this many issues: one is enough to reject, a few help fix it. */
const MAX_ISSUES = 20;

const isRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

type Sink = (path: string[], code: string, message: string) => void;

const scalarChecks: Partial<
  Record<
    ResolvedProperty["type"],
    (
      property: ResolvedProperty,
      value: unknown,
      fail: (code: string, message: string) => void,
    ) => void
  >
> = {
  string(property, value, fail) {
    if (typeof value !== "string") return fail("type", "expected string");
    const length = characters(value);
    const { min, max } = property as Extract<
      ResolvedProperty,
      { type: "string" }
    >;
    if (length < min) fail("too-short", `expected at least ${min} characters`);
    if (length > max) fail("too-long", `expected at most ${max} characters`);
  },
  enum(property, value, fail) {
    const { values } = property as Extract<ResolvedProperty, { type: "enum" }>;
    if (typeof value !== "string" || !values.includes(value))
      fail("enum", `expected one of ${values.join(", ")}`);
  },
  integer(property, value, fail) {
    if (typeof value !== "number" || !Number.isSafeInteger(value))
      return fail("type", "expected integer");
    numberRange(property, value, fail);
  },
  number(property, value, fail) {
    if (typeof value !== "number" || !Number.isFinite(value))
      return fail("type", "expected finite number");
    numberRange(property, value, fail);
  },
  boolean(_property, value, fail) {
    if (typeof value !== "boolean") fail("type", "expected boolean");
  },
  date(property, value, fail) {
    if (!isDate(value)) return fail("type", "expected date YYYY-MM-DD");
    const { min, max } = property as Extract<
      ResolvedProperty,
      { type: "date" }
    >;
    if (min !== null && value < min) fail("below", `expected ${min} or later`);
    if (max !== null && value > max)
      fail("above", `expected ${max} or earlier`);
  },
};

function numberRange(
  property: ResolvedProperty,
  value: number,
  fail: (code: string, message: string) => void,
) {
  const { min, max } = property as Extract<
    ResolvedProperty,
    { type: "integer" | "number" }
  >;
  if (min !== null && value < min) fail("below", `expected at least ${min}`);
  if (max !== null && value > max) fail("above", `expected at most ${max}`);
}

function checkObject(
  properties: Record<string, ResolvedProperty>,
  value: unknown,
  path: string[],
  sink: Sink,
) {
  if (!isRecord(value)) return sink(path, "type", "expected object");
  for (const key of Object.keys(value))
    if (!Object.hasOwn(properties, key))
      sink([...path, key], "unknown", "not declared");
  for (const [name, property] of Object.entries(properties)) {
    if (!Object.hasOwn(value, name) || value[name] === undefined) {
      if (!property.optional) sink([...path, name], "required", "required");
      continue;
    }
    checkProperty(property, value[name], [...path, name], sink);
  }
}

function checkList(
  property: Extract<ResolvedProperty, { type: "list" }>,
  value: unknown,
  path: string[],
  sink: Sink,
) {
  if (!Array.isArray(value)) return sink(path, "type", "expected list");
  if (value.length < property.min)
    sink(path, "too-few", `expected at least ${property.min} items`);
  if (value.length > property.max)
    return sink(path, "too-many", `expected at most ${property.max} items`);
  // Findings categories count once each, so a count never depends on repeats.
  if (property.role === "findings" && new Set(value).size !== value.length)
    sink(path, "duplicate", "repeats an item");
  value.forEach((item, index) =>
    checkProperty(property.of, item, [...path, String(index)], sink),
  );
}

function checkProperty(
  property: ResolvedProperty,
  value: unknown,
  path: string[],
  sink: Sink,
) {
  if (property.type === "object")
    return checkObject(property.properties, value, path, sink);
  if (property.type === "list") return checkList(property, value, path, sink);
  scalarChecks[property.type]!(property, value, (code, message) =>
    sink(path, code, message),
  );
}

/** Every way the value breaks the shape, up to a bound; empty when it conforms. */
export function validateValue(
  shape: ResolvedShape,
  value: unknown,
): ValueIssue[] {
  const issues: ValueIssue[] = [];
  const sink: Sink = (path, code, message) => {
    if (issues.length < MAX_ISSUES)
      issues.push({ path: path.join(".") || "(value)", code, message });
  };
  checkObject(shape.properties, value, [], sink);
  return issues;
}

/**
 * How many findings a valid value reports: the sum of the counts, or the
 * number of categories. Null when the shape has no findings role or the
 * value leaves an optional findings property out.
 */
export function findingsCount(
  shape: ResolvedShape,
  value: Record<string, unknown>,
) {
  const entry = Object.entries(shape.properties).find(
    ([, p]) => p.role === "findings",
  );
  if (!entry || value[entry[0]] === undefined) return null;
  const found = value[entry[0]];
  if (Array.isArray(found)) return found.length;
  return Object.values(found as Record<string, number>).reduce(
    (sum, n) => sum + n,
    0,
  );
}

/** The value at a path; undefined when any part is missing. Lists are never entered. */
export function valueAt(value: unknown, path: string[]): unknown {
  let here = value;
  for (const key of path) {
    if (!isRecord(here) || !Object.hasOwn(here, key)) return undefined;
    here = here[key];
  }
  return here;
}

const holds = (condition: CompiledCondition, found: unknown) => {
  switch (condition.op) {
    case "eq":
      return found === condition.value;
    case "in":
      return condition.values.some((item) => item === found);
    case "range": {
      if (typeof found !== "number" && typeof found !== "string") return false;
      if (typeof found !== typeof (condition.min ?? condition.max))
        return false;
      return (
        (condition.min === null || found >= condition.min) &&
        (condition.max === null || found <= condition.max)
      );
    }
  }
};

/** Whether every condition holds. A missing value satisfies none, optional or not. */
export function matchWhere(conditions: CompiledCondition[], value: unknown) {
  return conditions.every((condition) => {
    const found = valueAt(value, condition.path);
    return found !== undefined && holds(condition, found);
  });
}
