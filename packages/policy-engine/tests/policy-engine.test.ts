import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  evaluate,
  policyDocument,
  simulationRequest,
  simulate,
  type Descriptor,
  type EvaluatedRule,
} from "../src/index";
import {
  actionDigest,
  descriptorDigest,
  isPlainJson,
  nonceDigest,
  type ActionDescriptor,
} from "../src/protocol";

const conformance = JSON.parse(
  readFileSync(
    new URL("./fixtures/conformance-v1.json", import.meta.url),
    "utf8",
  ),
) as {
  version: number;
  evaluation_cases: Array<{
    id: string;
    descriptor: Descriptor;
    rules: Array<{
      id: string;
      effect: EvaluatedRule["effect"];
      agentKey?: string | null;
      installationName?: string | null;
      resource?: EvaluatedRule["resource"];
      conditions?: EvaluatedRule["conditions"];
      expiresAt?: string | null;
    }>;
    now?: string;
    expected: {
      outcome: "deny" | "require_approval" | "allow" | "none";
      matchedRuleId: string | null;
    };
  }>;
  digest_vectors: Array<{
    installationId: string;
    actionId: string;
    descriptor: ActionDescriptor;
    nonce: string;
    expected: {
      descriptorDigest: string;
      actionDigest: string;
      nonceDigest: string;
    };
  }>;
};

const now = new Date("2026-11-09T12:00:00.000Z");

const descriptor: Descriptor = {
  agentId: "support-agent",
  installationId: "support-dev",
  toolKey: "github",
  operationKey: "issues.delete",
  resourceKind: "repository",
  resourceId: "acme/support",
  params: { issue: 482, labels: ["resolved"] },
};

const policyRule = (effect: "allow" | "deny" | "require_approval") => ({
  id: `${effect}-rule`,
  name: `${effect} rule`,
  effect,
  agentKey: "support-agent",
  installationName: "support-dev",
  toolKey: "github",
  operationKey: "issues.delete",
  resource: { kind: "repository", match: "exact", value: "acme/support" },
  conditions: [],
  expiresAt: null,
});

describe("policy-engine evaluation contract", () => {
  test.each(conformance.evaluation_cases)(
    "conformance fixture %s",
    (fixture) => {
      const rules = fixture.rules.map(
        (item) =>
          ({
            logicalRuleId: item.id,
            effect: item.effect,
            agentId: item.agentKey ?? null,
            installationId: item.installationName ?? null,
            resource: (item.resource as EvaluatedRule["resource"]) ?? {
              kind: "repository",
              match: "any",
            },
            conditions: (item.conditions as EvaluatedRule["conditions"]) ?? [],
            expiresAt: item.expiresAt ? new Date(item.expiresAt) : null,
            toolKey: "github",
            operationKey: "issues.delete",
          }) satisfies EvaluatedRule,
      );
      expect(
        evaluate(
          fixture.descriptor,
          rules,
          new Date(fixture.now ?? "2026-11-09T12:00:00.000Z"),
        ),
      ).toEqual(fixture.expected);
    },
  );

  test.each(["constructor", "toString", "__proto__.x"])(
    "does not treat inherited %s as a supplied parameter",
    (field) => {
      const sparse = { ...descriptor, params: {} };
      const condition = { field, op: "neq" as const, value: "unexpected" };
      const decision = (effect: "allow" | "deny" | "require_approval") =>
        simulate({
          document: {
            version: 1,
            rules: [{ ...policyRule(effect), conditions: [condition] }],
          },
          descriptor: sparse,
          now,
        });
      expect(decision("allow").outcome).toBe("none");
      expect(decision("deny").outcome).toBe("deny");
      expect(decision("require_approval").outcome).toBe("require_approval");
    },
  );

  test("allows an explicitly supplied own constructor parameter", () => {
    const own = { ...descriptor, params: { constructor: "expected" } };
    const result = simulate({
      document: {
        version: 1,
        rules: [
          {
            ...policyRule("allow"),
            conditions: [{ field: "constructor", op: "eq", value: "expected" }],
          },
        ],
      },
      descriptor: own,
      now,
    });
    expect(result.outcome).toBe("allow");
  });
});

describe("policy document simulation", () => {
  test("returns an explanation from the same evaluator result", () => {
    const result = simulate({
      document: {
        version: 1,
        rules: [policyRule("deny")],
      },
      descriptor,
      now,
    });
    expect(result).toEqual({
      outcome: "deny",
      matchedRuleId: "deny-rule",
      reason: "explicit_rule",
      explanation: "Matched deny-rule with effect deny.",
      // A version 1 document has no gates or budgets to report.
      gates: [],
      budgets: [],
      warnings: [],
    });
    expect("permit_id" in result).toBe(false);
  });

  test("uses the supplied clock and does not read current time implicitly", () => {
    const result = simulate({
      document: { version: 1, rules: [policyRule("allow")] },
      descriptor,
      now: new Date("2099-01-01T00:00:00.000Z"),
    });
    expect(result.outcome).toBe("allow");
  });

  test.each([
    ["unknown version", { version: 2, rules: [] }],
    ["extra document key", { version: 1, rules: [], cloudOnly: true }],
    ["malformed rule", { version: 1, rules: [{ effect: "allow" }] }],
  ])("rejects %s", (_label, document) => {
    expect(() => simulate({ document, descriptor, now })).toThrow();
  });

  test.each([
    ["non-JSON parameter", { ...descriptor, params: { amount: Number.NaN } }],
    ["missing resource id", { ...descriptor, resourceId: "" }],
  ])("rejects a malformed descriptor: %s", (_label, malformed) => {
    expect(() =>
      simulate({
        document: { version: 1, rules: [] },
        descriptor: malformed,
        now,
      }),
    ).toThrow();
  });

  test("rejects an invalid evaluation clock before evaluating expiry", () => {
    expect(() =>
      simulate({
        document: { version: 1, rules: [] },
        descriptor,
        now: new Date("invalid"),
      }),
    ).toThrow();
  });

  test("schema accepts the documented portable v1 policy and rejects an unknown version", () => {
    expect(
      policyDocument.safeParse({ version: 1, rules: [policyRule("allow")] })
        .success,
    ).toBe(true);
    expect(policyDocument.safeParse({ version: 9, rules: [] }).success).toBe(
      false,
    );
  });

  test("rejects duplicate rule ids in one policy document", () => {
    const duplicate = policyRule("allow");
    expect(
      policyDocument.safeParse({
        version: 1,
        rules: [duplicate, { ...duplicate, effect: "deny" }],
      }).success,
    ).toBe(false);
  });

  test("simulationRequest itself rejects non-JSON parameters", () => {
    const request = {
      version: 1 as const,
      descriptor: {
        agentId: "support-agent",
        installationId: "support-dev",
        toolKey: "github",
        operationKey: "issues.delete",
        resourceKind: "repository",
        resourceId: "acme/support",
        params: {},
      },
      rules: [],
      now: now.toISOString(),
    };
    expect(
      simulationRequest.safeParse({
        ...request,
        descriptor: { ...request.descriptor, params: { amount: Number.NaN } },
      }).success,
    ).toBe(false);
    expect(
      simulationRequest.safeParse({
        ...request,
        descriptor: { ...request.descriptor, params: { fn: () => undefined } },
      }).success,
    ).toBe(false);
    expect(
      simulationRequest.safeParse({
        ...request,
        descriptor: { ...request.descriptor, params: { constructor: "own" } },
      }).success,
    ).toBe(true);
  });
});

describe("protocol conformance vectors", () => {
  const vector = conformance.digest_vectors[0];

  test("keeps the stable RFC 8785 digest vector", () => {
    expect(descriptorDigest(vector.installationId, vector.descriptor)).toBe(
      vector.expected.descriptorDigest,
    );
  });

  test("keeps action and nonce digest vectors stable", () => {
    expect(
      actionDigest(vector.actionId, vector.expected.descriptorDigest),
    ).toBe(vector.expected.actionDigest);
    expect(nonceDigest(vector.nonce)).toBe(vector.expected.nonceDigest);
  });

  test("changes the digest when installation identity changes", () => {
    expect(
      descriptorDigest("another-installation", vector.descriptor),
    ).not.toBe(vector.expected.descriptorDigest);
  });

  test("rejects non-plain JSON before a descriptor can be trusted", () => {
    expect(isPlainJson({ value: Number.NaN })).toBe(false);
    expect(isPlainJson(new Date())).toBe(false);
    expect(isPlainJson({ value: [1, "ok", null] })).toBe(true);
  });

  test("rejects cycles but accepts shared acyclic objects", () => {
    const shared = { value: "ok" };
    expect(isPlainJson({ first: shared, second: shared })).toBe(true);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(isPlainJson(cycle)).toBe(false);
  });
});
