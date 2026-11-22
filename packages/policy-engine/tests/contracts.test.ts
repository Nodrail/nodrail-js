// Declared contracts, dialect 1: the frozen fixtures for every coverage ID,
// and the rules around them (digests, projections, authority, older engines).
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { parse } from "yaml";
import { projectManifest, setupFields } from "../src/project-manifest";
import { SETUP_KEYS } from "../src/shapes/grammar";
import { resource } from "../src/project-resources";
import { compilePolicies } from "../src/yaml";
import {
  CONSUMERS,
  SURFACES,
  approvalBinding,
  approvalStillBinds,
  compileContracts,
  contractDigest,
  findingsCount,
  isDate,
  lockSection,
  matchWhere,
  projectValue,
  recordEnvelope,
  reportedRecord,
  satisfiesAuthority,
  sha256Hex,
  validateValue,
  type ContractSources,
  type ResolvedShape,
} from "../src/shapes/index";

const fixtures = join(import.meta.dirname, "fixtures/contracts");
const readYaml = (text: string) =>
  parse(text, {
    schema: "core",
    uniqueKeys: true,
    maxAliasCount: 50,
  }) as Record<string, unknown>;

type Fixture = ContractSources & {
  description: string;
  expect?: { code: string; path: string }[];
};

const FIXTURE_KEYS = [
  "description",
  "nodrail.yaml",
  "resources",
  "policy",
  "modules",
  "lock",
  "cases",
  "expect",
];

function load(id: string, file: string): Fixture {
  const doc = readYaml(readFileSync(join(fixtures, id, file), "utf8"));
  for (const key of Object.keys(doc))
    expect(FIXTURE_KEYS, `${id}/${file}`).toContain(key);
  return { ...(doc as Fixture), manifest: doc["nodrail.yaml"] };
}

const compile = (fixture: Fixture) => compileContracts(fixture);
const ids = [...SURFACES, ...CONSUMERS];
const filesOf = (id: string) =>
  readdirSync(join(fixtures, id))
    .filter((f) => f.endsWith(".yaml"))
    .sort();

test("every coverage ID has a valid and a rejected fixture", () => {
  expect(readdirSync(fixtures).sort()).toEqual([...ids].sort());
  for (const id of ids) {
    expect(
      filesOf(id).some((f) => f.startsWith("valid")),
      id,
    ).toBe(true);
    expect(
      filesOf(id).some((f) => f.startsWith("rejected")),
      id,
    ).toBe(true);
  }
});

/** What a valid fixture must show it exercised, beyond compiling cleanly. */
function exercised(
  id: string,
  fixture: Fixture,
  result: ReturnType<typeof compile>,
) {
  const contracts = result.contracts!;
  if (id.startsWith("S")) return contracts.surfaces.includes(id as never);
  if (id === "C06") return result.cases.length > 0;
  if (id === "C07") return fixture.lock !== undefined;
  if (id === "C08") return (fixture.modules ?? []).length > 0;
  return contracts.consumerIds.includes(id as never);
}

describe.each(ids)("%s", (id) => {
  test.each(filesOf(id).filter((f) => f.startsWith("valid")))(
    "%s compiles, and its cases pass",
    (file) => {
      const fixture = load(id, file);
      const result = compile(fixture);
      expect(result.issues).toEqual([]);
      expect(result.cases.filter((c) => !c.passed)).toEqual([]);
      expect(exercised(id, fixture, result)).toBe(true);
    },
  );

  test.each(filesOf(id).filter((f) => f.startsWith("rejected")))(
    "%s is refused for the stated reasons",
    (file) => {
      const fixture = load(id, file);
      const result = compile(fixture);
      expect(result.ok).toBe(false);
      expect(result.contracts).toBeNull();
      const said = result.issues.map((issue) => ({
        code: issue.code,
        path: issue.path.join("."),
      }));
      expect(
        fixture.expect?.length,
        "a rejected fixture says why",
      ).toBeGreaterThan(0);
      for (const want of fixture.expect!)
        expect(
          said.some(
            (s) => s.code === want.code && s.path.startsWith(want.path),
          ),
          `${want.code} at ${want.path} in ${JSON.stringify(said)}`,
        ).toBe(true);
    },
  );
});

test("the contracts grammar lets through exactly the keys the setup owns", () => {
  const owned = ["kind", "imports", ...Object.keys(setupFields)].filter(
    (key) => key !== "connections",
  );
  expect([...SETUP_KEYS].sort()).toEqual(owned.sort());
});

describe("older engines refuse contracts instead of ignoring them", () => {
  test("nodrail.yaml with shapes", () => {
    const parsed = projectManifest.safeParse({
      kind: "nodrail.project/v1",
      shapes: {},
    });
    expect(parsed.success).toBe(false);
  });

  test("an Agent with a receipt or a brief", () => {
    for (const spec of [{ receipt: "qa" }, { brief: "b" }])
      expect(
        resource.safeParse({
          apiVersion: "apf.nodrail.com/v1alpha1",
          kind: "Agent",
          metadata: { name: "qa" },
          spec,
        }).success,
      ).toBe(false);
  });

  test("a rule file asking for a later engine level, or with a rule where", () => {
    const level = compilePolicies([
      { name: "a.yaml", text: "- required_engine_version: 6\n" },
    ]);
    expect(level.ok).toBe(false);
    const where = compilePolicies([
      {
        name: "b.yaml",
        text: "- rule: R\n  tool: t\n  operation: o\n  resource: { kind: k, match: any }\n  where: { input.amount: 1 }\n  effect: allow\n",
      },
    ]);
    expect(where.ok).toBe(false);
  });
});

describe("digests", () => {
  test("the SHA-256 here is node's", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 300 }), (text) => {
        expect(sha256Hex(text)).toBe(
          createHash("sha256").update(text, "utf8").digest("hex"),
        );
      }),
    );
    expect(sha256Hex("x".repeat(1_000_000))).toBe(
      createHash("sha256").update("x".repeat(1_000_000)).digest("hex"),
    );
  });

  const digestOf = (shapes: unknown) => {
    const result = compileContracts({ manifest: { shapes } });
    expect(result.issues).toEqual([]);
    return Object.fromEntries(
      Object.entries(result.contracts!.shapes).map(([n, s]) => [n, s.contract]),
    );
  };

  test("pin content, not spelling: key order, defaults and extends don't move them", () => {
    const a = digestOf({
      x: {
        properties: { n: { type: "integer", min: 0 }, s: { type: "string" } },
      },
    });
    const b = digestOf({
      x: {
        properties: {
          s: { max: 1000, type: "string", optional: false },
          n: { min: 0, type: "integer" },
        },
      },
    });
    const c = digestOf({
      base: { properties: { s: { type: "string" } } },
      x: { extends: "base", properties: { n: { type: "integer", min: 0 } } },
    });
    expect(b.x).toBe(a.x);
    expect(c.x).toBe(a.x);
  });

  test("move with any change that matters, descriptions included", () => {
    const a = digestOf({ x: { properties: { s: { type: "string" } } } });
    for (const change of [
      { max: 999 },
      { optional: true },
      { for: "Text" },
      { report: true },
      { classification: "pii" },
    ])
      expect(
        digestOf({ x: { properties: { s: { type: "string", ...change } } } }).x,
      ).not.toBe(a.x);
  });

  test("domains keep one kind of digest from passing for another", () => {
    expect(contractDigest("shape", {})).not.toBe(
      contractDigest("projection", {}),
    );
  });

  test("the lock section a compile writes is the one it accepts", () => {
    const fixture = load("C07", "valid-lock.yaml");
    const first = compile({ ...fixture, lock: undefined });
    const lock = lockSection(first.contracts!);
    expect(compile({ ...fixture, lock }).issues).toEqual([]);
  });
});

const shape = (properties: ResolvedShape["properties"]): ResolvedShape => ({
  for: null,
  properties,
});
const resolved = (shapes: unknown, name: string) => {
  const result = compileContracts({ manifest: { shapes } });
  expect(result.issues).toEqual([]);
  return result.contracts!.shapes[name]!;
};

describe("projections", () => {
  test("a redacted required string leaves a valid projection, without claiming the full value", () => {
    const { shape: full, projection } = resolved(
      {
        r: {
          properties: {
            verdict: { values: ["done", "blocked"], role: "verdict" },
            summary: { type: "string", max: 300 },
          },
        },
      },
      "r",
    );
    const value = { verdict: "done", summary: "Private customer detail" };
    expect(validateValue(full, value)).toEqual([]);
    const projected = projectValue(projection, value);
    expect(projected).toEqual({ verdict: "done" });
    expect(validateValue(projection.shape, projected)).toEqual([]);
    expect(projection.withheld).toEqual(["summary"]);
    // The projection is no full receipt: checked against the full contract it fails.
    expect(validateValue(full, projected).map((i) => i.code)).toEqual([
      "required",
    ]);
  });

  test("a secret child stays out of a reporting parent; report false opts a child out", () => {
    const { projection } = resolved(
      {
        r: {
          properties: {
            deploy: {
              report: true,
              properties: {
                environment: { values: ["staging", "production"] },
                token: { type: "string", classification: "secret" },
                note: { type: "string", report: false },
              },
            },
          },
        },
      },
      "r",
    );
    expect(
      Object.keys(
        (projection.shape.properties.deploy as { properties: object })
          .properties,
      ),
    ).toEqual(["environment"]);
    // Withheld paths are a set, sorted: the order written changes no digest.
    expect(projection.withheld).toEqual(["deploy.note", "deploy.token"]);
    const reordered = resolved(
      {
        r: {
          properties: {
            deploy: {
              report: true,
              properties: {
                note: { type: "string", report: false },
                token: { type: "string", classification: "secret" },
                environment: { values: ["staging", "production"] },
              },
            },
          },
        },
      },
      "r",
    ).projection;
    expect(reordered.digest).toBe(projection.digest);
  });

  test("enums, numbers and booleans are opt-in too; verdict and usage are built in", () => {
    const { projection } = resolved(
      {
        r: {
          properties: {
            verdict: { values: ["pass", "fail"], role: "verdict" },
            usage: {
              role: "usage",
              properties: { tokens: { type: "integer", min: 0 } },
            },
            mode: { values: ["fast", "full"] },
            count: { type: "integer" },
            ok: { type: "boolean" },
          },
        },
      },
      "r",
    );
    expect(Object.keys(projection.shape.properties)).toEqual([
      "verdict",
      "usage",
    ]);
  });

  test("lists of objects keep their reported fields only", () => {
    const { projection } = resolved(
      {
        r: {
          properties: {
            items: {
              type: "list",
              of: {
                properties: {
                  sku: { type: "string", report: true },
                  email: { type: "string" },
                },
              },
            },
          },
        },
      },
      "r",
    );
    const value = { items: [{ sku: "a", email: "x@y.z" }] };
    expect(projectValue(projection, value)).toEqual({ items: [{ sku: "a" }] });
    expect(projection.withheld).toEqual(["items.email"]);
  });
});

describe("where", () => {
  const conditions = [
    { path: ["findings", "blocker"], op: "eq" as const, value: 0 },
    { path: ["lesson"], op: "in" as const, values: ["a"] },
  ];

  test("a missing optional value satisfies nothing", () => {
    expect(matchWhere([conditions[0]!], { findings: { blocker: 0 } })).toBe(
      true,
    );
    expect(matchWhere(conditions, { findings: { blocker: 0 } })).toBe(false);
  });

  test("no conversions, and lists are never searched", () => {
    expect(matchWhere([conditions[0]!], { findings: { blocker: "0" } })).toBe(
      false,
    );
    expect(
      matchWhere([{ path: ["tags"], op: "in", values: ["a"] }], {
        tags: ["a"],
      }),
    ).toBe(false);
  });

  test("ranges hold for numbers and dates, each against its own kind", () => {
    const range = {
      path: ["d"],
      op: "range" as const,
      min: "2026-01-01",
      max: null,
    };
    expect(matchWhere([range], { d: "2026-11-21" })).toBe(true);
    expect(matchWhere([range], { d: 20261121 })).toBe(false);
    expect(
      matchWhere([{ path: ["n"], op: "range", min: null, max: 2 }], { n: 3 }),
    ).toBe(false);
  });
});

test("an invalid shape is the only error: what reads it isn't reported too", () => {
  const result = compileContracts({
    manifest: {
      shapes: {
        "refund-args": {
          properties: {
            amount: { type: "integer", min: 1 },
            token: {
              type: "string",
              max: 64,
              classification: "secret",
              report: true,
            },
          },
        },
      },
      connections: {
        stripe: { operations: { refund: { input: "refund-args" } } },
      },
    },
    policy: [
      { required_engine_version: 4 },
      {
        rule: "Small refunds",
        tool: "stripe",
        operation: "refund",
        resource: { kind: "mcp_tool", match: "any" },
        where: { "input.amount": { max: 5000 } },
        effect: "allow",
      },
    ],
  });
  expect(result.issues.map((issue) => issue.code)).toEqual([
    "report-classified",
  ]);
});

describe("validation", () => {
  const s = shape({
    when: {
      type: "date",
      min: "2026-01-01",
      max: "2026-12-31",
      optional: true,
      for: null,
      report: null,
      classification: null,
      role: null,
    },
    text: {
      type: "string",
      min: 2,
      max: 3,
      optional: true,
      for: null,
      report: null,
      classification: null,
      role: null,
    },
    tags: {
      type: "list",
      min: 1,
      max: 2,
      optional: true,
      for: null,
      report: null,
      classification: null,
      role: null,
      of: {
        type: "boolean",
        optional: false,
        for: null,
        report: null,
        classification: null,
        role: null,
      },
    },
  });

  test("names the path and the reason, never the value", () => {
    const issues = validateValue(s, {
      when: "2027-01-01",
      text: "secret-value",
      tags: [],
    });
    expect(issues.map((i) => `${i.path}: ${i.code}`)).toEqual([
      "when: above",
      "text: too-long",
      "tags: too-few",
    ]);
    expect(JSON.stringify(issues)).not.toContain("secret-value");
  });

  test("a parsed Date, an array or a class instance is no object or date", () => {
    expect(validateValue(s, { when: new Date() })[0]?.code).toBe("type");
    expect(validateValue(s, [])[0]?.code).toBe("type");
    expect(validateValue(s, new Map())[0]?.code).toBe("type");
    expect(validateValue(s, { tags: [true, true, true] })[0]?.code).toBe(
      "too-many",
    );
    expect(
      validateValue(s, { when: "2025-12-31", text: "a" }).map((i) => i.code),
    ).toEqual(["below", "too-short"]);
  });

  test("findings count: the sum of counts, or the number of categories", () => {
    const counts = resolved(
      {
        r: {
          properties: {
            f: {
              role: "findings",
              properties: {
                a: { type: "integer", min: 0 },
                b: { type: "integer", min: 0 },
              },
            },
          },
        },
      },
      "r",
    );
    expect(findingsCount(counts.shape, { f: { a: 2, b: 3 } })).toBe(5);
    const list = resolved(
      {
        r: {
          properties: {
            f: {
              role: "findings",
              optional: true,
              type: "list",
              of: { values: ["x", "y"] },
            },
          },
        },
      },
      "r",
    );
    expect(findingsCount(list.shape, { f: ["x", "y"] })).toBe(2);
    expect(findingsCount(list.shape, {})).toBeNull();
  });
});

describe("authority", () => {
  test("a stronger producer meets a weaker requirement, never the reverse", () => {
    expect(satisfiesAuthority("externally-verified", "runtime-observed")).toBe(
      true,
    );
    expect(satisfiesAuthority("agent-reported", "runtime-observed")).toBe(
      false,
    );
    expect(satisfiesAuthority("person-authenticated", "agent-reported")).toBe(
      false,
    );
    expect(
      satisfiesAuthority("externally-verified", "person-authenticated"),
    ).toBe(false);
    expect(
      satisfiesAuthority("person-authenticated", "person-authenticated"),
    ).toBe(true);
  });

  test("an approval binds the exact action, form values, schemas and policy", () => {
    const subject = {
      action: "sha256:a",
      request: { contract: "sha256:r", value: { amount: 4200 } },
      decision: null,
      policy: "sha256:p",
    };
    const recorded = approvalBinding(subject);
    expect(approvalStillBinds(recorded, subject)).toBe(true);
    for (const changed of [
      { ...subject, action: "sha256:b" },
      { ...subject, request: { ...subject.request, value: { amount: 4300 } } },
      { ...subject, request: { ...subject.request, contract: "sha256:r2" } },
      { ...subject, decision: "sha256:d" },
      { ...subject, policy: "sha256:q" },
    ])
      expect(approvalStillBinds(recorded, changed)).toBe(false);
  });

  const envelope = {
    surface: "S01",
    producer: { class: "agent-reported", id: "reviewer" },
    contract: {
      name: "reviewer-result",
      digest: `sha256:${"a".repeat(64)}`,
      dialect: 1,
    },
    projection: { digest: `sha256:${"b".repeat(64)}` },
    validation: { state: "valid", at: "local", issues: [] },
    project: "unbound:demo",
    machine: "m1",
    host: { runtime: "claude-code", version: "2.1.0" },
    run: "r1",
    step: "s1",
    agent: "reviewer",
    dispatch: "d1",
    event: "e1",
    occurred_at: "2026-11-21T10:00:00Z",
    recorded_at: "2026-11-21T10:00:01Z",
    subject: { kind: "revision", digest: "1f52bc4" },
  };

  test("a reported record carries the runtime envelope and names its projection", () => {
    expect(
      reportedRecord.safeParse({
        envelope,
        values: { verdict: "ship" },
        findings_count: 1,
      }).success,
    ).toBe(true);
    expect(
      reportedRecord.safeParse({
        envelope: { ...envelope, projection: null },
        values: {},
        findings_count: null,
      }).success,
    ).toBe(false);
  });

  test("the envelope is strict: no agent-supplied freshness or extra identity", () => {
    expect(recordEnvelope.safeParse(envelope).success).toBe(true);
    expect(recordEnvelope.safeParse({ ...envelope, fresh: true }).success).toBe(
      false,
    );
    expect(
      recordEnvelope.safeParse({
        ...envelope,
        validation: { ...envelope.validation, state: "pass" },
      }).success,
    ).toBe(false);
  });
});

test("compile refuses a manifest that isn't contracts grammar", () => {
  const result = compileContracts({
    manifest: { shapes: { Bad: { properties: {} } }, unknown_key: 1 },
  });
  expect(result.ok).toBe(false);
  expect(result.issues.map((i) => i.code)).toEqual(
    expect.arrayContaining(["grammar"]),
  );
});

// Every other refusal the compiler makes, one declaration each.
const verdict = { values: ["pass", "fail"], role: "verdict" };
const one = (properties: unknown) => ({ shapes: { s: { properties } } });
const asReceipt = (properties: unknown) => ({
  ...one(properties),
  receipts: { qa: { shape: "s" } },
});
const agent = (name: string, spec: object = {}) => ({
  apiVersion: "apf.nodrail.com/v1alpha1",
  kind: "Agent",
  metadata: { name },
  spec,
});
const gate = (requires: unknown[]) => [
  { required_engine_version: 4 },
  {
    gate: "G",
    tool: "t",
    operation: "o",
    resource: { kind: "k", match: "any" },
    requires,
    otherwise: "deny",
  },
];
const ci = {
  ...one({ status: { values: ["passed", "failed"], report: true } }),
  evidence: { ci: { shape: "s", producers: [{ class: "runtime-observed" }] } },
};

const refusals: [string, ContractSources, string, string][] = [
  [
    "two type sources",
    {
      manifest: one({
        a: { values: ["x"], properties: { b: { type: "string" } } },
      }),
    },
    "grammar",
    "nodrail.yaml.shapes.s.properties.a",
  ],
  [
    "type next to values",
    { manifest: one({ a: { type: "string", values: ["x"] } }) },
    "grammar",
    "nodrail.yaml.shapes.s.properties.a.type",
  ],
  [
    "type that doesn't match of",
    { manifest: one({ a: { type: "object", of: { type: "string" } } }) },
    "grammar",
    "nodrail.yaml.shapes.s.properties.a.type",
  ],
  [
    "no type at all",
    { manifest: one({ a: { optional: true } }) },
    "grammar",
    "nodrail.yaml.shapes.s.properties.a",
  ],
  [
    "a list without of",
    { manifest: one({ a: { type: "list" } }) },
    "grammar",
    "nodrail.yaml.shapes.s.properties.a",
  ],
  [
    "a unit on a string",
    { manifest: one({ a: { type: "string", unit: "ms" } }) },
    "grammar",
    "nodrail.yaml.shapes.s.properties.a.unit",
  ],
  [
    "optional on a list item",
    {
      manifest: one({
        a: { type: "list", of: { type: "string", optional: true } },
      }),
    },
    "grammar",
    "nodrail.yaml.shapes.s.properties.a.of.optional",
  ],
  [
    "a bad item inside a list",
    {
      manifest: one({ a: { type: "list", of: { type: "string", max: 2000 } } }),
    },
    "grammar",
    "nodrail.yaml.shapes.s.properties.a.of.max",
  ],
  [
    "a number bound on a date",
    { manifest: one({ a: { type: "date", min: 3 } }) },
    "grammar",
    "nodrail.yaml.shapes.s.properties.a.min",
  ],
  [
    "min on an enum",
    { manifest: one({ a: { values: ["x"], min: 1 } }) },
    "grammar",
    "nodrail.yaml.shapes.s.properties.a.min",
  ],
  [
    "a list over 50 items",
    { manifest: one({ a: { type: "list", of: { type: "string" }, max: 51 } }) },
    "grammar",
    "nodrail.yaml.shapes.s.properties.a.max",
  ],
  [
    "an unknown parent",
    {
      manifest: {
        shapes: {
          s: { extends: "nope", properties: { a: { type: "string" } } },
        },
      },
    },
    "unknown-shape",
    "nodrail.yaml.shapes.s.extends",
  ],
  [
    "extending itself",
    {
      manifest: {
        shapes: { s: { extends: "s", properties: { a: { type: "string" } } } },
      },
    },
    "extends-chain",
    "nodrail.yaml.shapes.s.extends",
  ],
  [
    "a nested role",
    { manifest: one({ a: { properties: { v: verdict } } }) },
    "role-placement",
    "nodrail.yaml.shapes.s.properties.a.v",
  ],
  [
    "an optional verdict",
    { manifest: one({ v: { ...verdict, optional: true } }) },
    "role-placement",
    "nodrail.yaml.shapes.s.properties.v",
  ],
  [
    "a verdict that isn't a run word",
    { manifest: one({ v: { values: ["v1.0"], role: "verdict" } }) },
    "role-placement",
    "nodrail.yaml.shapes.s.properties.v",
  ],
  [
    "a classified role",
    { manifest: one({ v: { ...verdict, classification: "pii" } }) },
    "role-placement",
    "nodrail.yaml.shapes.s.properties.v",
  ],
  [
    "findings as text",
    { manifest: one({ f: { type: "string", role: "findings" } }) },
    "role-placement",
    "nodrail.yaml.shapes.s.properties.f",
  ],
  [
    "usage as a number",
    { manifest: one({ u: { type: "integer", role: "usage" } }) },
    "role-placement",
    "nodrail.yaml.shapes.s.properties.u",
  ],
  [
    "usage with other fields",
    {
      manifest: one({
        u: { role: "usage", properties: { cost: { type: "number", min: 0 } } },
      }),
    },
    "role-placement",
    "nodrail.yaml.shapes.s.properties.u",
  ],
  [
    "usage that could go negative",
    {
      manifest: one({
        u: { role: "usage", properties: { usd: { type: "number" } } },
      }),
    },
    "role-placement",
    "nodrail.yaml.shapes.s.properties.u",
  ],
  [
    "a header alias to nothing, twice",
    {
      manifest: {
        ...asReceipt({ v: verdict }),
        receipts: {
          qa: {
            shape: "s",
            format: "header",
            header: {
              aliases: { result: "v", outcome: "v", other: "missing" },
            },
          },
        },
      },
    },
    "unknown-reference",
    "nodrail.yaml.receipts.qa.header.aliases",
  ],
  [
    "a header on a fenced receipt",
    {
      manifest: {
        ...asReceipt({ v: verdict }),
        receipts: { qa: { shape: "s", header: {} } },
      },
    },
    "grammar",
    "nodrail.yaml.receipts.qa",
  ],
  [
    "an Agent's unknown receipt",
    {
      manifest: asReceipt({ v: verdict }),
      resources: [agent("qa", { receipt: "tester" })],
    },
    "unknown-reference",
    "resources.0.spec.receipt",
  ],
  [
    "an Agent with a bad name",
    { resources: [{ kind: "Agent", metadata: { name: "Bad Name" } }] },
    "grammar",
    "resources.0.metadata.name",
  ],
  [
    "a memory write whose input is another shape",
    {
      manifest: {
        shapes: {
          note: { properties: { kind: { values: ["lesson"], role: "kind" } } },
          other: { properties: { a: { type: "string" } } },
        },
        connections: {
          m: { command: "x", operations: { put: { input: "other" } } },
        },
        memory: {
          notes: {
            shape: "note",
            connection: "m",
            operations: { create: "put" },
            writers: {},
          },
        },
      },
    },
    "binding-conflict",
    "nodrail.yaml.memory.notes.operations.create",
  ],
  [
    "a writer that isn't an Agent",
    {
      manifest: {
        files: {
          f: {
            root: "./docs",
            pattern: "*.md",
            sections: ["A"],
            writers: ["ghost"],
          },
        },
      },
    },
    "unknown-reference",
    "nodrail.yaml.files.f.writers.0",
  ],
  [
    "a requirement with an unknown key",
    {
      manifest: asReceipt({ v: verdict }),
      resources: [agent("qa")],
      policy: gate([{ agent: "qa", verdict: "pass", fresh: true }]),
    },
    "grammar",
    "policy.1.requires.0",
  ],
  [
    "an evidence requirement without authority",
    { manifest: ci.shapes && ci, policy: gate([{ evidence: "ci" }]) },
    "grammar",
    "policy.1.requires.0.authority",
  ],
  [
    "unknown evidence",
    {
      manifest: ci,
      policy: gate([{ evidence: "cd", authority: "runtime-observed" }]),
    },
    "unknown-reference",
    "policy.1.requires.0.evidence",
  ],
  [
    "a revision the evidence isn't bound to",
    {
      manifest: ci,
      policy: gate([
        { evidence: "ci", authority: "runtime-observed", subject: "revision" },
      ]),
    },
    "subject",
    "policy.1.requires.0.subject",
  ],
  [
    "a condition on evidence that can't hold",
    {
      manifest: ci,
      policy: gate([
        {
          evidence: "ci",
          authority: "runtime-observed",
          where: { status: true },
        },
      ]),
    },
    "path-type",
    "policy.1.requires.0.where.status",
  ],
  [
    "an unknown approval form",
    {
      policy: [
        { required_engine_version: 4 },
        { rule: "R", effect: "require_approval", approval: "nope" },
      ],
    },
    "unknown-reference",
    "policy.1.approval",
  ],
  [
    "a rule-file item that isn't an entry",
    { policy: ["- rule: R"] },
    "grammar",
    "policy.0",
  ],
  [
    "a budget on an operation without contracts",
    {
      policy: [
        { required_engine_version: 4 },
        {
          budget: "B",
          sum: { tool: "t", operation: "o", path: "input.n" },
          unit: "ms",
        },
      ],
    },
    "path",
    "policy.1.sum.path",
  ],
  [
    "a budget on a number with no unit",
    {
      manifest: {
        ...one({ n: { type: "integer" } }),
        connections: { t: { command: "x", operations: { o: { input: "s" } } } },
      },
      policy: [
        { required_engine_version: 4 },
        {
          budget: "B",
          sum: { tool: "t", operation: "o", path: "input.n" },
          unit: "ms",
        },
      ],
    },
    "unit",
    "policy.1.unit",
  ],
  [
    "a sum over text",
    {
      manifest: {
        ...ci,
        insights: {
          i: { source: { evidence: "ci" }, measure: "sum", path: "status" },
        },
      },
    },
    "path-type",
    "nodrail.yaml.insights.i.path",
  ],
  [
    "an insight on an unknown source",
    {
      manifest: {
        insights: { i: { source: { memory: "notes" }, measure: "count" } },
      },
    },
    "unknown-reference",
    "nodrail.yaml.insights.i.source",
  ],
  [
    "a notification on an unknown source",
    {
      manifest: {
        notifications: {
          n: { source: { approval: "x" }, to: { role: "admin" } },
        },
      },
    },
    "unknown-reference",
    "nodrail.yaml.notifications.n.source",
  ],
  ["a lock that isn't one", { lock: { dialect: 2 } }, "grammar", "lock"],
  [
    "a lock pinning a shape that's gone",
    {
      lock: {
        dialect: 1,
        digest: `sha256:${"0".repeat(64)}`,
        shapes: {
          gone: {
            contract: `sha256:${"0".repeat(64)}`,
            projection: `sha256:${"0".repeat(64)}`,
          },
        },
      },
    },
    "lock-mismatch",
    "lock.shapes.gone",
  ],
  ["a case that isn't one", { cases: [{ name: "x" }] }, "grammar", "cases.0"],
  [
    "a case expecting an issue that isn't there",
    {
      manifest: one({ a: { type: "string" } }),
      cases: [
        {
          name: "c",
          target: "shape:s",
          value: { a: 1, b: 2 },
          expect: "invalid",
          issues: ["a: required"],
        },
      ],
    },
    "case-failed",
    "cases.0",
  ],
  [
    "a case expecting invalid for a valid value",
    {
      manifest: one({ a: { type: "string" } }),
      cases: [
        { name: "c", target: "shape:s", value: { a: "x" }, expect: "invalid" },
      ],
    },
    "case-failed",
    "cases.0",
  ],
  [
    "a case with the wrong projection",
    {
      manifest: one({ a: { type: "string" } }),
      cases: [
        {
          name: "c",
          target: "shape:s",
          value: { a: "x" },
          expect: "valid",
          projection: { a: "x" },
        },
      ],
    },
    "case-failed",
    "cases.0",
  ],
  [
    "a case on a shape that doesn't exist",
    {
      cases: [{ name: "c", target: "shape:nope", value: {}, expect: "valid" }],
    },
    "unknown-reference",
    "cases.0.target",
  ],
  [
    "too many cases",
    {
      manifest: one({ a: { type: "string" } }),
      cases: Array.from({ length: 201 }, () => ({
        name: "c",
        target: "shape:s",
        value: { a: "x" },
        expect: "valid",
      })),
    },
    "grammar",
    "cases",
  ],
  [
    "too many shapes",
    {
      manifest: {
        shapes: Object.fromEntries(
          Array.from({ length: 100 }, (_, i) => [
            `a${i}`,
            { properties: { a: { type: "string" } } },
          ]),
        ),
      },
      modules: [
        {
          ref: "@x/y@1.0.0",
          shapes: Object.fromEntries(
            Array.from({ length: 40 }, (_, i) => [
              `b${i}`,
              { properties: { a: { type: "string" } } },
            ]),
          ),
        },
      ],
    },
    "grammar",
    "nodrail.yaml.shapes",
  ],
  ...(["secret", "pii"] as const).map(
    (classification): [string, ContractSources, string, string] => [
      `a resource named by a ${classification} argument`,
      {
        manifest: {
          ...one({
            card: { type: "string", classification },
            amount: { type: "integer" },
          }),
          connections: {
            stripe: {
              command: "x",
              operations: {
                refund: {
                  input: "s",
                  resource: { kind: "charge", from: "card" },
                },
              },
            },
          },
        },
      },
      "classified-resource",
      "nodrail.yaml.connections.stripe.operations.refund.resource.from",
    ],
  ),
];

test("a resource named by an unclassified argument compiles", () => {
  const result = compileContracts({
    manifest: {
      ...one({
        charge: { type: "string" },
        card: { type: "string", classification: "secret" },
      }),
      connections: {
        stripe: {
          command: "x",
          operations: {
            refund: {
              input: "s",
              resource: { kind: "charge", from: "charge" },
            },
          },
        },
      },
    },
  });
  expect(result.issues).toEqual([]);
  // The message names the argument, never a value.
  const refused = compileContracts(refusals.at(-1)![1]);
  expect(refused.issues.map((i) => i.message)).toEqual([
    "card is classified, so it can't name the resource: the resource is shown wherever the action is",
  ]);
});

test.each(refusals)("refuses %s", (_name, sources, code, path) => {
  const result = compileContracts(sources);
  const said = result.issues.map((i) => `${i.code} @ ${i.path.join(".")}`);
  expect(
    said.some((s) => s.startsWith(`${code} @ ${path}`)),
    said.join("\n"),
  ).toBe(true);
});

const whereOn = (properties: object, where: object) => ({
  manifest: {
    ...asReceipt({ v: verdict, ...properties }),
  },
  resources: [agent("qa")],
  policy: gate([{ agent: "qa", verdict: "pass", where }]),
});

test.each([
  ["in on a date", { d: { type: "date" } }, { d: { in: ["2026-01-01"] } }],
  ["in on a boolean", { b: { type: "boolean" } }, { b: { in: ["true"] } }],
  ["a range on text", { t: { type: "string" } }, { t: { min: 1 } }],
  [
    "a range on a date with a number",
    { d: { type: "date" } },
    { d: { max: 20260101 } },
  ],
  ["an empty range", { n: { type: "integer" } }, { n: { min: 5, max: 1 } }],
  [
    "an exact object",
    { o: { properties: { a: { type: "string" } } } },
    { o: "x" },
  ],
  ["a decimal for an integer", { n: { type: "integer" } }, { n: 1.5 }],
  ["text for a number", { n: { type: "number" } }, { n: "1" }],
  ["a non-date for a date", { d: { type: "date" } }, { d: "2026-13-01" }],
])("where refuses %s", (_name, properties, where) => {
  const said = compileContracts(whereOn(properties, where)).issues.map(
    (i) => i.code,
  );
  expect(said).toContain("path-type");
});

test.each([
  [
    "exact values of each type",
    {
      s: { type: "string" },
      n: { type: "number" },
      b: { type: "boolean" },
      d: { type: "date" },
    },
    { s: "x", n: 1.5, b: false, d: "2026-02-28" },
  ],
  [
    "ranges on numbers and dates",
    { n: { type: "number" }, d: { type: "date" } },
    { n: { min: 0.5, max: 2 }, d: { min: "2026-01-01" } },
  ],
  [
    "in on text and integers",
    { s: { type: "string" }, i: { type: "integer" } },
    { s: { in: ["a", "b"] }, i: { in: [1, 2] } },
  ],
])("where accepts %s", (_name, properties, where) => {
  expect(compileContracts(whereOn(properties, where)).issues).toEqual([]);
});

test("a path into a scalar has no properties", () => {
  const said = compileContracts(
    whereOn({ n: { type: "integer" } }, { "n.x": 1 }),
  ).issues;
  expect(said.map((i) => i.code)).toEqual(["path"]);
});

test("a rule on a started agent reads its brief", () => {
  const result = compileContracts({
    manifest: one({ env: { values: ["staging", "production"] } }),
    resources: [agent("deployer", { brief: "s" })],
    policy: [
      { required_engine_version: 4 },
      {
        rule: "R",
        tool: "claude-code",
        operation: "agent",
        resource: { kind: "agent", match: "exact", value: "deployer" },
        where: { "brief.env": "production" },
        effect: "deny",
      },
      {
        rule: "S",
        tool: "claude-code",
        operation: "agent",
        resource: { kind: "agent", match: "exact", value: "nobody" },
        where: { "brief.env": "production" },
        effect: "deny",
      },
    ],
  });
  expect(result.issues.map((i) => `${i.code} @ ${i.path.join(".")}`)).toEqual([
    "path @ policy.2.where.brief.env",
  ]);
});

test("dates are real Gregorian days, written as text", () => {
  for (const good of ["2024-02-29", "2000-02-29", "2026-12-31"])
    expect(isDate(good)).toBe(true);
  for (const bad of [
    "2026-02-29",
    "1900-02-29",
    "2026-00-10",
    "2026-04-31",
    "2026-01-00",
    20260101,
    "26-01-01",
  ])
    expect(isDate(bad)).toBe(false);
});

test("a value that isn't JSON has no digest", () => {
  expect(() => contractDigest("value", undefined)).toThrow();
  expect(
    approvalBinding({
      action: "a",
      request: { contract: "c", value: undefined },
      decision: null,
      policy: "p",
    }),
  ).toMatch(/^sha256:/);
});

test("validation reports at most 20 issues, and checks each scalar type", () => {
  const many = shape(
    Object.fromEntries(
      Array.from({ length: 25 }, (_, i) => [
        `p${i}`,
        {
          type: "boolean",
          optional: false,
          for: null,
          report: null,
          classification: null,
          role: null,
        },
      ]),
    ) as ResolvedShape["properties"],
  );
  expect(validateValue(many, {})).toHaveLength(20);
  const { shape: typed } = resolved(
    {
      r: {
        properties: {
          s: { type: "string" },
          n: { type: "number", max: 1 },
          b: { type: "boolean" },
          l: { type: "list", of: { type: "string" } },
        },
      },
    },
    "r",
  );
  expect(
    validateValue(typed, { s: 1, n: 2, b: "true", l: "x" }).map(
      (i) => `${i.path}: ${i.code}`,
    ),
  ).toEqual(["s: type", "n: above", "b: type", "l: type"]);
  expect(
    validateValue(typed, { s: "", n: Number.NaN, b: true, l: [] })[0]?.code,
  ).toBe("type");
  expect(
    matchWhere([{ path: ["b"], op: "range", min: 0, max: null }], { b: true }),
  ).toBe(false);
});

test("an Agent picks the receipt of its name, and plan sees it as implicit", () => {
  const result = compileContracts({
    manifest: asReceipt({ v: verdict }),
    resources: [agent("qa"), agent("dev"), { kind: "Team" }, null],
  });
  expect(result.contracts?.agents).toEqual({
    dev: { receipt: null, implicit: false, brief: null },
    qa: { receipt: "qa", implicit: true, brief: null },
  });
});

test("a project with no contracts compiles to an empty closure", () => {
  const result = compileContracts({});
  expect(result.ok).toBe(true);
  expect(result.contracts?.surfaces).toEqual([]);
});

describe("docs/contracts.md", () => {
  test("has examples, and each compiles", () => {
    const page = readFileSync(
      join(import.meta.dirname, "../docs/contracts.md"),
      "utf8",
    );
    const blocks = [
      ...page.matchAll(/^```yaml contracts\n([\s\S]*?)^```$/gm),
    ].map(([, body]) => body ?? "");
    expect(blocks.length).toBeGreaterThan(3);
    for (const body of blocks) {
      const doc = readYaml(body);
      const result = compileContracts({
        ...(doc as ContractSources),
        manifest: doc["nodrail.yaml"],
      });
      expect(result.issues).toEqual([]);
    }
  });
});
