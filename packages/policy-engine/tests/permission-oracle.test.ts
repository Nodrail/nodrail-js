// The permission diff checked against the evaluator itself. For any two
// policies, every call is decided before and after; what the reviewer is told
// must not contradict what actually changed. In particular, a call that a
// deny or a gate blocked and that is now allowed must never go unflagged.
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import type { PolicyDocument, PolicyGate, PolicyRule } from "../src/policies";
import { simulate } from "../src/simulator";
import { permissionChanges, type PermissionChange } from "../src/yaml";
import { stepEvents, type Step } from "./support/run-events";

const now = new Date("2026-11-10T12:00:00.000Z");

const resource = fc.constantFrom<PolicyRule["resource"]>(
  { kind: "r", match: "any" },
  { kind: "r", match: "exact", value: "r1" },
  { kind: "r", match: "exact", value: "r2" },
  { kind: "r", match: "prefix", value: "r1" },
  { kind: "r", match: "prefix", value: "r" },
);
const conditions = fc.constantFrom<PolicyRule["conditions"]>(
  [],
  [{ field: "n", op: "lt", value: 5 }],
  [{ field: "n", op: "lt", value: 10 }],
  [{ field: "n", op: "gt", value: 3 }],
);
const scope = {
  agentKey: fc.constantFrom(null, "dev", "ops"),
  operationKey: fc.constantFrom("a.x", "a.y"),
  resource,
  conditions,
};
const fixed = { installationName: null, toolKey: "t", expiresAt: null };

const rule = fc
  .record({
    id: fc.constantFrom("p", "q", "s", "u"),
    effect: fc.constantFrom("allow", "deny"),
    ...scope,
  })
  .map((fields): PolicyRule => ({ ...fixed, name: fields.id, ...fields }));

/** What a gate waits for: which verdicts pass, what resets them, and who. */
const requires = fc.constantFrom<PolicyGate["requires"]>(
  [{ agent: "qa", verdicts: ["pass"], since: [] }],
  [{ agent: "qa", verdicts: ["pass", "fail"], since: [] }],
  [{ agent: "qa", verdicts: ["pass"], since: ["dev"] }],
  [
    { agent: "qa", verdicts: ["pass"], since: [] },
    { agent: "reviewer", verdicts: ["ship"], since: [] },
  ],
);

const gate = fc
  .record({
    effect: fc.constant("deny" as const),
    requires,
    ...scope,
  })
  .map((fields): PolicyGate => ({ ...fixed, id: "g", name: "g", ...fields }));

/** A small policy: up to four rules with distinct ids, and maybe a gate. */
const policy = fc
  .record({
    rules: fc.uniqueArray(rule, { selector: (item) => item.id, maxLength: 4 }),
    gate: fc.option(gate, { nil: null }),
  })
  .map(({ rules, gate }): PolicyDocument => ({
    version: 2,
    rules,
    gates: gate ? [gate] : [],
    budgets: [],
  }));

const calls = ["dev", "ops", "qa"].flatMap((agentId) =>
  ["a.x", "a.y"].flatMap((operationKey) =>
    ["r1", "r2", "r10", "s"].flatMap((resourceId) =>
      [1, 4, 7, 20].map((n) => ({
        agentId,
        installationId: "i",
        toolKey: "t",
        operationKey,
        resourceKind: "r",
        resourceId,
        params: { n },
      })),
    ),
  ),
);

/** How much a decision lets through. No rule is the default: blocked. */
const rank = { none: 0, deny: 0, allow: 1 } as const;

/** Runs the calls are made in: none, and checkers' verdicts in some order. */
const at = now.toISOString();
const histories: Step[][] = [
  [["qa", "fail"]],
  [["qa", "pass"]],
  [
    ["qa", "pass"],
    ["reviewer", "ship"],
  ],
  [["qa", "pass"], ["reviewer", "ship"], ["dev"]],
];
const runs = [
  null,
  ...histories.map((steps) => ({
    run: "r",
    step: null,
    events: stepEvents(steps, at),
  })),
];
function decide(document: PolicyDocument) {
  return runs.flatMap((run) =>
    calls.map((descriptor) => {
      const result = simulate({ document, descriptor, now, run } as Parameters<
        typeof simulate
      >[0]);
      return {
        rank: rank[result.outcome],
        blocked:
          result.outcome === "deny" && result.reason !== "no_matching_rule",
      };
    }),
  );
}

/** What actually happened to the calls between two policies. */
function effect(before: PolicyDocument, after: PolicyDocument) {
  const [was, is] = [decide(before), decide(after)];
  return {
    wider: was.some((_, index) => is[index]!.rank > was[index]!.rank),
    narrower: was.some((_, index) => is[index]!.rank < was[index]!.rank),
    unblocked: was.some(
      (_, index) => was[index]!.blocked && is[index]!.rank === rank.allow,
    ),
  };
}

const says = (changes: PermissionChange[], impacts: string[]) =>
  changes.some((change) => impacts.includes(change.impact));

const cases = { numRuns: 400 };
// Each case decides every call twice; CI with coverage needs more than 5s.
const timeout = 60_000;

describe("the permission diff agrees with the evaluator", () => {
  test(
    "anything let through more is reported as more, or for review",
    () => {
      fc.assert(
        fc.property(policy, policy, (before, after) => {
          if (!effect(before, after).wider) return;
          const changes = permissionChanges(before, after);
          expect(
            says(changes, ["granted", "loosened", "changed", "needs_review"]),
          ).toBe(true);
        }),
        cases,
      );
    },
    timeout,
  );

  test(
    "anything let through less is reported as less, or for review",
    () => {
      fc.assert(
        fc.property(policy, policy, (before, after) => {
          if (!effect(before, after).narrower) return;
          const changes = permissionChanges(before, after);
          expect(
            says(changes, ["revoked", "tightened", "changed", "needs_review"]),
          ).toBe(true);
        }),
        cases,
      );
    },
    timeout,
  );

  test(
    "a call a deny or a gate blocked, now allowed, is always flagged",
    () => {
      fc.assert(
        fc.property(policy, policy, (before, after) => {
          if (!effect(before, after).unblocked) return;
          const changes = permissionChanges(before, after);
          expect(changes.some((change) => change.warning)).toBe(true);
        }),
        cases,
      );
    },
    timeout,
  );

  test(
    "no change in any decision is never reported as a grant or a loss",
    () => {
      fc.assert(
        fc.property(policy, (document) => {
          expect(
            permissionChanges(document, structuredClone(document)),
          ).toEqual([]);
        }),
        cases,
      );
    },
    timeout,
  );
});
