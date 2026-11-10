// The core decision, operator by operator. Every path here decides whether an
// agent's action may run, so each one is pinned down directly.
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import {
  compare,
  conditionsMatch,
  matches,
  readField,
  type Descriptor,
  type EvaluatedRule,
} from "../src/evaluator.ts";
import { descriptorDigest } from "../src/protocol.ts";
import { simulate } from "../src/simulator.ts";

const descriptor = (params: Record<string, unknown> = {}): Descriptor => ({
  agentId: "agent",
  installationId: "laptop",
  toolKey: "stripe",
  operationKey: "refunds.create",
  resourceKind: "invoice",
  resourceId: "INV-1",
  params,
});

const rule = (overrides: Partial<EvaluatedRule> = {}): EvaluatedRule => ({
  logicalRuleId: "r",
  effect: "allow",
  agentId: null,
  installationId: null,
  toolKey: "stripe",
  operationKey: "refunds.create",
  resource: { kind: "invoice", match: "any" },
  conditions: [],
  expiresAt: null,
  ...overrides,
});

describe("each operator", () => {
  test.each([
    ["eq", 5, 5, true],
    ["eq", 5, 6, false],
    ["neq", 5, 6, true],
    ["neq", 5, 5, false],
    ["gt", 6, 5, true],
    ["gt", 5, 5, false],
    ["gte", 5, 5, true],
    ["gte", 4, 5, false],
    ["lt", 4, 5, true],
    ["lt", 5, 5, false],
    ["lte", 5, 5, true],
    ["lte", 6, 5, false],
    ["in", "EUR", ["USD", "EUR"], true],
    ["in", "GBP", ["USD", "EUR"], false],
    ["contains", [".env", "src"], ".env", true],
    ["contains", ["src"], ".env", false],
  ] as const)("%s: %j against %j is %s", (op, actual, value, expected) => {
    expect(compare(actual, { field: "x", op, value } as never)).toBe(expected);
  });

  test.each(["gt", "gte", "lt", "lte"] as const)(
    "%s never compares a number with something that isn't one",
    (op) => {
      expect(compare("6", { field: "x", op, value: 5 } as never)).toBe(false);
      expect(compare(6, { field: "x", op, value: "5" } as never)).toBe(false);
    },
  );

  test("in and contains need a list", () => {
    expect(compare("a", { field: "x", op: "in", value: "a" } as never)).toBe(
      false,
    );
    expect(
      compare("a", { field: "x", op: "contains", value: "a" } as never),
    ).toBe(false);
  });
});

describe("a missing or wrong-typed parameter", () => {
  const amountUnder = (effect: EvaluatedRule["effect"]) =>
    rule({ effect, conditions: [{ field: "amount", op: "lte", value: 1000 }] });

  test.each([
    ["missing", {}],
    ["a string", { amount: "5" }],
    ["a list", { amount: [5] }],
  ])("%s never helps an allow rule", (_label, params) => {
    expect(conditionsMatch(amountUnder("allow"), descriptor(params))).toBe(
      false,
    );
  });

  test.each([
    ["missing", {}],
    ["a string", { amount: "5" }],
  ])("%s still lets a deny or review rule apply", (_label, params) => {
    expect(conditionsMatch(amountUnder("deny"), descriptor(params))).toBe(true);
    expect(
      conditionsMatch(amountUnder("require_approval"), descriptor(params)),
    ).toBe(true);
  });

  test("in with no item of the same type never helps an allow", () => {
    const currencies = rule({
      conditions: [{ field: "currency", op: "in", value: ["USD"] }],
    });
    expect(conditionsMatch(currencies, descriptor({ currency: 1 }))).toBe(
      false,
    );
  });

  test("whatever the value, a wrong type never satisfies an allow on a number", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          fc.boolean(),
          fc.array(fc.integer()),
          fc.object(),
        ),
        (amount) =>
          !conditionsMatch(amountUnder("allow"), descriptor({ amount })),
      ),
    );
  });
});

describe("which rules apply", () => {
  const now = new Date("2026-11-10T12:00:00.000Z");

  test.each([
    [
      "an expired rule",
      rule({ expiresAt: new Date("2026-11-10T11:59:59.000Z") }),
    ],
    ["another agent's rule", rule({ agentId: "other" })],
    [
      "another installation's rule",
      rule({ agentId: "agent", installationId: "other" }),
    ],
    ["another tool", rule({ toolKey: "github" })],
    ["another operation", rule({ operationKey: "refunds.list" })],
    [
      "another resource kind",
      rule({ resource: { kind: "customer", match: "any" } }),
    ],
    [
      "another exact resource",
      rule({ resource: { kind: "invoice", match: "exact", value: "INV-2" } }),
    ],
    [
      "a prefix that doesn't fit",
      rule({ resource: { kind: "invoice", match: "prefix", value: "CUS-" } }),
    ],
    [
      "a prefix with no value",
      rule({ resource: { kind: "invoice", match: "prefix" } }),
    ],
  ])("%s doesn't apply", (_label, candidate) => {
    expect(matches(candidate, descriptor(), now)).toBe(false);
  });

  test.each([
    [
      "a rule for this agent and installation",
      rule({ agentId: "agent", installationId: "laptop" }),
    ],
    [
      "a rule that expires later",
      rule({ expiresAt: new Date("2026-11-10T12:00:01.000Z") }),
    ],
    [
      "an exact resource",
      rule({ resource: { kind: "invoice", match: "exact", value: "INV-1" } }),
    ],
    [
      "a fitting prefix",
      rule({ resource: { kind: "invoice", match: "prefix", value: "INV-" } }),
    ],
  ])("%s applies", (_label, candidate) => {
    expect(matches(candidate, descriptor(), now)).toBe(true);
  });
});

describe("reading a field", () => {
  test("follows dots into objects", () => {
    expect(readField({ input: { amount: 5 } }, "input.amount")).toBe(5);
    expect(readField({ input: 5 }, "input.amount")).toBeUndefined();
    expect(readField({ input: null }, "input.amount")).toBeUndefined();
  });

  test.each(["__proto__", "constructor", "toString", "input.__proto__"])(
    "never reads %s from a prototype",
    (path) => {
      expect(readField({ input: {} }, path)).toBeUndefined();
    },
  );
});

describe("refusing what can't be judged", () => {
  const document = { version: 1 as const, rules: [] };
  const plain = {
    agentId: "a",
    installationId: "i",
    toolKey: "t",
    operationKey: "o",
    resourceKind: "k",
    resourceId: "r",
    params: {},
  };

  test("a clock that isn't a date", () => {
    expect(() =>
      simulate({ document, descriptor: plain, now: new Date("nope") }),
    ).toThrow(/valid date/);
  });

  test("parameters that aren't plain JSON", () => {
    expect(() =>
      simulate({
        document,
        descriptor: { ...plain, params: { amount: Number.NaN } },
        now: new Date(),
      }),
    ).toThrow();
  });

  test("a descriptor that can't be written out is refused, not fingerprinted", () => {
    const descriptor = {
      tool: "t",
      operation: "o",
      resource: { kind: "k", id: "r" },
      params: { x: 10n },
    };
    expect(() => descriptorDigest("i", descriptor as never)).toThrow();
  });
});
