// What an edit to a policy does to permissions, as `nodrail policy lock` shows
// it to a reviewer. Removing a deny or a gate requirement must never go quiet.
import { describe, expect, test } from "vitest";
import {
  compilePolicies,
  permissionChanges,
  renderPermissionChanges,
  type PermissionChange,
} from "../src/yaml";
import type {
  PolicyBudget,
  PolicyDocument,
  PolicyGate,
  PolicyRule,
} from "../src/policies";

const compiled = (text: string): PolicyDocument => {
  const result = compilePolicies([{ name: "rules.yaml", text }]);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.document;
};

const diff = (before: string | null, after: string) =>
  permissionChanges(before === null ? null : compiled(before), compiled(after));

const brief = ({ impact, warning, id, summary }: PermissionChange) => ({
  impact,
  warning,
  id,
  summary,
});

const v3 = "- required_engine_version: 3\n";

const refunds = (fields: string) => `
- rule: Refunds
  id: refunds
  tool: stripe
  operation: refunds.create
${fields}`;

const gate = (requires: string) => `${v3}
- rule: Push
  id: push
  command: { prefix: git push }
  effect: allow
- gate: Review before a push
  id: review-push
  command: git push
  requires:
${requires}
  otherwise: deny
`;

describe("permissionChanges", () => {
  test("a first install reports everything as new", () => {
    const changes = diff(
      null,
      `${v3}
- rule: Read files
  tool: files
  operation: file.read
  resource: { kind: path, match: any }
  effect: allow
- rule: Ask for refunds
  tool: stripe
  operation: refunds.create
  resource: { kind: invoice, match: any }
  effect: require_approval
- rule: Never drop tables
  command: dropdb
  effect: deny
- budget: Calls
  per: run
  tool_calls: 100
  otherwise: deny
`,
    );
    expect(changes.map(brief)).toEqual([
      {
        impact: "granted",
        warning: false,
        id: "read-files",
        summary: "added (allow)",
      },
      {
        impact: "tightened",
        warning: false,
        id: "never-drop-tables",
        summary: "added (deny)",
      },
      {
        impact: "granted",
        warning: false,
        id: "ask-for-refunds",
        summary: "added (require approval)",
      },
      {
        impact: "tightened",
        warning: false,
        id: "calls",
        summary: "added: deny over 100 tool_calls per run",
      },
    ]);
  });

  test("unchanged documents, or conditions only reordered, show nothing", () => {
    const text = refunds(`  resource: { kind: invoice, match: any }
  condition:
    - { field: amount, op: lt, value: 100 }
    - { field: currency, op: eq, value: USD }
  effect: allow`);
    const before = compiled(text);
    const after = structuredClone(before);
    after.rules[0]?.conditions.reverse();
    expect(permissionChanges(before, before)).toEqual([]);
    expect(permissionChanges(before, after)).toEqual([]);
    expect(renderPermissionChanges([])).toBe("No permission changes.\n");
  });

  test("a removed gate is loosened and flagged", () => {
    const before = gate("    - { agent: reviewer, verdict: ship }");
    const after = before.replace(/- gate:[\s\S]*$/, "");
    expect(diff(before, `${v3}${after}`).map(brief)).toEqual([
      {
        impact: "loosened",
        warning: true,
        id: "review-push",
        summary: "removed",
      },
    ]);
  });

  test("a removed gate requirement is flagged; a new one tightens", () => {
    const one = gate("    - { agent: reviewer, verdict: ship }");
    const two = gate(
      "    - { agent: reviewer, verdict: ship }\n    - { agent: qa, verdict: pass }",
    );
    expect(diff(two, one).map(brief)).toEqual([
      {
        impact: "loosened",
        warning: true,
        id: "review-push",
        summary: "no longer requires qa: pass",
      },
    ]);
    expect(diff(one, two).map(brief)).toEqual([
      {
        impact: "tightened",
        warning: false,
        id: "review-push",
        summary: "requires qa: pass",
      },
    ]);
  });

  test("a new checker next to a `since` requirement needs review", () => {
    const one = gate("    - { agent: reviewer, verdict: ship, since: [dev] }");
    const two = gate(
      "    - { agent: reviewer, verdict: ship, since: [dev] }\n    - { agent: qa, verdict: pass }",
    );
    const [change] = diff(one, two);
    expect(change?.impact).toBe("needs_review");
    expect(change?.details[0]).toContain("qa's commands no longer count");
  });

  test("accepting more verdicts loosens a gate, more `since` agents tighten it; both at once needs review", () => {
    const base = gate("    - { agent: reviewer, verdict: ship, since: [dev] }");
    const moreVerdicts = gate(
      "    - { agent: reviewer, verdict: [ship, ship_with_debt], since: [dev] }",
    );
    const moreSince = gate(
      "    - { agent: reviewer, verdict: ship, since: [dev, infra] }",
    );
    expect(diff(base, moreVerdicts)[0]?.impact).toBe("loosened");
    expect(diff(base, moreSince)[0]?.impact).toBe("tightened");
    expect(diff(moreVerdicts, moreSince)[0]?.impact).toBe("tightened");
    const both = gate(
      "    - { agent: reviewer, verdict: [ship, ship_with_debt], since: [dev, infra] }",
    );
    expect(diff(base, both)[0]?.impact).toBe("needs_review");
  });

  test("a removed deny is loosened and flagged; so is a deny turned into an allow", () => {
    const deny = `- rule: No force push
  id: no-force
  command: git push --force
  effect: deny
`;
    expect(diff(deny, "[]").map(brief)).toEqual([
      {
        impact: "loosened",
        warning: true,
        id: "no-force",
        summary: "removed (deny)",
      },
    ]);
    expect(diff(deny, deny.replace("deny", "allow")).map(brief)).toEqual([
      {
        impact: "loosened",
        warning: true,
        id: "no-force",
        summary: "effect deny → allow",
      },
    ]);
  });

  test("an allow turned into a deny or a review is tightened", () => {
    const allow = refunds(
      "  resource: { kind: invoice, match: any }\n  effect: allow",
    );
    for (const effect of ["deny", "require_approval"])
      expect(
        diff(allow, allow.replace("effect: allow", `effect: ${effect}`))[0],
      ).toMatchObject({
        impact: "tightened",
        warning: false,
      });
  });

  test.each([
    ["exact", "prefix", "loosened"],
    ["prefix", "any", "loosened"],
    ["exact", "any", "loosened"],
    ["any", "exact", "tightened"],
  ])(
    "an allow's resource %s → %s is %s, under its operation",
    (from, to, impact) => {
      const scope = (match: string) =>
        match === "any"
          ? "{ kind: path, match: any }"
          : `{ kind: path, match: ${match}, value: src/app }`;
      const rule = (match: string) => `- rule: Write source
  id: write-src
  tool: files
  operation: file.write
  resource: ${scope(match)}
  effect: allow
`;
      const [change] = diff(rule(from), rule(to));
      expect(change).toMatchObject({ impact, operation: "files.file.write" });
      expect(change?.summary).toMatch(/^resource path /);
    },
  );

  test("a deny that covers less is loosened and flagged; one that covers more tightens", () => {
    const rule = (value: string) =>
      refunds(`  resource: { kind: invoice, match: prefix, value: ${value} }
  effect: deny`);
    expect(diff(rule("INV"), rule("INV-9"))[0]).toMatchObject({
      impact: "loosened",
      warning: true,
    });
    expect(diff(rule("INV-9"), rule("INV"))[0]).toMatchObject({
      impact: "tightened",
      warning: false,
    });
  });

  test("a resource moved somewhere unrelated is revoked there and granted here", () => {
    const rule = (value: string) =>
      refunds(
        `  resource: { kind: invoice, match: exact, value: ${value} }\n  effect: allow`,
      );
    expect(
      diff(rule("INV-1"), rule("INV-2")).map(
        ({ impact, resource, summary }) => [impact, resource, summary],
      ),
    ).toEqual([
      ["revoked", 'invoice exact "INV-1"', "moved away (allow)"],
      ["granted", 'invoice exact "INV-2"', "moved here (allow)"],
    ]);
  });

  test("conditions that neither add to nor drop from the others need review", () => {
    const rule = (condition: string) =>
      refunds(`  resource: { kind: invoice, match: any }
  condition: [${condition}]
  effect: allow`);
    const [change] = diff(
      rule("{ field: amount, op: lt, value: 100 }"),
      rule("{ field: amount, op: lt, value: 500 }"),
    );
    expect(change).toMatchObject({ impact: "needs_review", warning: false });
    expect(change?.details).toEqual([
      "before: invoice (any) where amount lt 100",
      "after: invoice (any) where amount lt 500",
    ]);
    const extra = diff(
      rule("{ field: amount, op: lt, value: 100 }"),
      rule(
        "{ field: amount, op: lt, value: 100 }, { field: currency, op: eq, value: USD }",
      ),
    );
    expect(extra[0]).toMatchObject({
      impact: "tightened",
      details: ['+ currency eq "USD"'],
    });
  });

  test("a gate whose conditions can't be compared is flagged: it may cover less", () => {
    const hold = (condition: string) => `${v3}
- gate: Hold
  id: hold
  command: { prefix: git push }
  condition: [${condition}]
  requires: [{ agent: qa, verdict: pass }]
  otherwise: deny
`;
    expect(
      diff(
        hold("{ field: n, op: lt, value: 5 }"),
        hold("{ field: n, op: gt, value: 3 }"),
      )[0],
    ).toMatchObject({ impact: "needs_review", warning: true });
  });

  test("a removed review is looser only where an allow covers all of it", () => {
    const review = `- rule: Ask
  id: ask
  tool: stripe
  operation: refunds.create
  resource: { kind: invoice, match: any }
  effect: require_approval
`;
    const allow = (condition: string) => `- rule: Small
  id: small
  tool: stripe
  operation: refunds.create
  resource: { kind: invoice, match: any }
${condition}  effect: allow
`;
    expect(diff(review + allow(""), allow(""))[0]?.impact).toBe("loosened");
    // Refunds of 100 or more were asked about and are now blocked.
    const some = allow(
      "  condition: [{ field: amount, op: lt, value: 100 }]\n",
    );
    expect(diff(review + some, some)[0]?.impact).toBe("changed");
  });

  test("a wider scope with narrower conditions needs review, never tightened", () => {
    const before =
      refunds(`  resource: { kind: invoice, match: exact, value: INV-1 }
  effect: allow`);
    const after = refunds(`  resource: { kind: invoice, match: any }
  condition: [{ field: amount, op: lt, value: 100 }]
  effect: allow`);
    expect(diff(before, after)[0]?.impact).toBe("needs_review");
  });

  test("a budget raised loosens, lowered tightens, and a warning alone decides nothing", () => {
    const budget = (limit: number, warn = 40) => `${v3}
- budget: Calls
  per: run
  tool_calls: ${limit}
  warn_at: ${warn}
  otherwise: deny
`;
    expect(diff(budget(60), budget(100)).map(brief)).toEqual([
      {
        impact: "loosened",
        warning: true,
        id: "calls",
        summary: "limit 60 tool_calls per run → 100 tool_calls per run",
      },
    ]);
    expect(diff(budget(100), budget(60))[0]?.impact).toBe("tightened");
    expect(diff(budget(60), budget(60, 50))[0]).toMatchObject({
      impact: "changed",
      summary: "warn at 40 → 50",
    });
    expect(diff(budget(60), "[]")[0]).toMatchObject({
      impact: "loosened",
      warning: true,
    });
  });

  test("a rule renamed with nothing else changed is one rename, not revoke and grant", () => {
    const rule = (name: string) => `- rule: ${name}
  command: git status
  effect: allow
`;
    expect(diff(rule("Status"), rule("Show status")).map(brief)).toEqual([
      {
        impact: "changed",
        warning: false,
        id: "show-status",
        summary: 'renamed from status "Status"',
      },
    ]);
    const kept = (name: string) =>
      `- rule: ${name}\n  id: status\n  command: git status\n  effect: allow\n`;
    expect(diff(kept("Status"), kept("Show status"))[0]?.summary).toBe(
      'renamed "Status" → "Show status"',
    );
  });

  test("a new review where an allow may apply is only changed; elsewhere it grants", () => {
    const allow = `- rule: Refund small
  id: small
  tool: stripe
  operation: refunds.create
  resource: { kind: invoice, match: any }
  effect: allow
`;
    const ask = `- rule: Ask
  id: ask
  tool: stripe
  operation: refunds.create
  resource: { kind: invoice, match: prefix, value: EU- }
  effect: require_approval
`;
    expect(diff(allow, allow + ask).map(brief)).toEqual([
      {
        impact: "changed",
        warning: false,
        id: "ask",
        summary: "added (require approval)",
      },
    ]);
    expect(diff(allow + ask, allow)[0]?.impact).toBe("loosened");
    expect(diff(ask, "[]")[0]?.impact).toBe("revoked");
  });

  test("an agent's rule widened to every agent loosens; expiry moves with the effect", () => {
    const rule = (extra: string) => `- rule: Deploy
  id: deploy
  command: make deploy
  effect: allow
${extra}`;
    expect(diff(rule("  agent: ops\n"), rule(""))[0]).toMatchObject({
      impact: "loosened",
      agent: null,
    });
    expect(
      diff(rule("  agent: ops\n"), rule("  agent: dev\n")).map(
        ({ impact, agent }) => [impact, agent],
      ),
    ).toEqual([
      ["granted", "dev"],
      ["revoked", "ops"],
    ]);
    const until = (date: string) => `  expires: ${date}T00:00:00Z\n`;
    expect(
      diff(rule(until("2027-01-01")), rule(until("2028-01-01")))[0]?.impact,
    ).toBe("loosened");
    expect(diff(rule(""), rule(until("2027-01-01")))[0]?.impact).toBe(
      "tightened",
    );
  });
});

describe("renderPermissionChanges", () => {
  const before = `${v3}
- rule: No force push
  id: no-force
  agent: dev
  command: git push --force
  effect: deny
- rule: Read
  id: read
  tool: files
  operation: file.read
  resource: { kind: path, match: exact, value: src }
  effect: allow
- budget: Calls
  per: run
  tool_calls: 60
  otherwise: deny
`;
  const after = `${v3}
- rule: Read
  id: read
  tool: files
  operation: file.read
  resource: { kind: path, match: prefix, value: src }
  effect: allow
- rule: Write
  id: write
  tool: files
  operation: file.write
  resource: { kind: path, match: any }
  effect: allow
- budget: Calls
  per: run
  tool_calls: 100
  otherwise: deny
`;

  test("groups by agent, then operation, then resource, and marks a lost deny", () => {
    const lines = renderPermissionChanges(diff(before, after)).split("\n");
    expect(lines[0]).toMatch(/^4 permission changes, 2 marked !/);
    const at = (text: string) => lines.findIndex((line) => line.includes(text));
    // All agents come before a named one; within each, operation then resource.
    expect(at("All agents")).toBeLessThan(at("Agent dev"));
    expect(at("files.file.read")).toBeLessThan(at('path prefix "src"'));
    expect(at('path prefix "src"')).toBeLessThan(at("rule read"));
    expect(at("Budgets")).toBeGreaterThan(at("files.file.write"));
    expect(lines[at("rule no-force")]).toMatch(/^\s+! loosened/);
    expect(lines.filter((line) => line.includes("!")).length).toBe(3);
  });

  test("the same documents in any order give byte-identical output", () => {
    const shuffled = compiled(after);
    shuffled.rules.reverse();
    if (shuffled.version === 2) shuffled.budgets.reverse();
    const first = renderPermissionChanges(diff(before, after));
    const second = renderPermissionChanges(
      permissionChanges(compiled(before), shuffled),
    );
    expect(second).toBe(first);
    const changes = diff(before, after);
    expect(renderPermissionChanges([...changes].reverse())).toBe(first);
    expect(permissionChanges(compiled(before), shuffled)).toEqual(changes);
  });

  test("details sit under their change", () => {
    const rule = (value: number) =>
      ({
        id: "r",
        name: "R",
        effect: "allow",
        agentKey: null,
        installationName: "laptop",
        toolKey: "stripe",
        operationKey: "refunds.create",
        resource: { kind: "invoice", match: "any" },
        conditions: [{ field: "amount", op: "lt", value }],
        expiresAt: null,
      }) satisfies PolicyRule;
    const text = renderPermissionChanges(
      permissionChanges(
        { version: 1, rules: [rule(1)] },
        { version: 1, rules: [rule(2)] },
      ),
    );
    expect(text).toContain("All agents on laptop\n");
    expect(text).toContain("needs review  rule r");
    expect(text).toContain(
      "\n                      before: invoice (any) where amount lt 1\n",
    );
  });
});

describe("edited budgets", () => {
  const budget = (fields: Partial<PolicyBudget> = {}): PolicyBudget => ({
    id: "calls",
    name: "Calls",
    agent: null,
    per: "run",
    metric: "tool_calls",
    limit: 60,
    warnAt: null,
    effect: "deny",
    ...fields,
  });
  const document = (item: PolicyBudget): PolicyDocument => ({
    version: 2,
    rules: [],
    gates: [],
    budgets: [item],
  });
  const impact = (fields: Partial<PolicyBudget>) =>
    permissionChanges(document(budget()), document(budget(fields)))[0]?.impact;

  test("per step is looser than per run, a narrower agent looser than all", () => {
    expect(impact({ per: "step" })).toBe("loosened");
    expect(impact({ agent: "dev" })).toBe("loosened");
    expect(impact({ metric: "tokens", limit: 1000 })).toBe("changed");
    expect(
      permissionChanges(
        document(budget({ per: "step" })),
        document(budget()),
      )[0]?.impact,
    ).toBe("tightened");
  });
});

describe("edited gates", () => {
  const base: PolicyGate = {
    id: "hold",
    name: "Hold",
    effect: "deny",
    agentKey: null,
    installationName: null,
    toolKey: "shell",
    operationKey: "command.run",
    resource: { kind: "command", match: "prefix", value: "git push " },
    conditions: [],
    expiresAt: null,
    requires: [{ agent: "qa", verdicts: ["pass"], since: [] }],
  };
  const change = (
    fields: Partial<PolicyGate>,
    from: Partial<PolicyGate> = {},
  ) =>
    permissionChanges(
      { version: 2, rules: [], gates: [{ ...base, ...from }], budgets: [] },
      { version: 2, rules: [], gates: [{ ...base, ...fields }], budgets: [] },
    )[0];

  test("a gate that asks instead of denying loosens, and is flagged", () => {
    expect(change({ effect: "require_approval" })).toMatchObject({
      impact: "loosened",
      warning: true,
      summary: "otherwise deny → require approval",
    });
    expect(change({}, { effect: "require_approval" })?.impact).toBe(
      "tightened",
    );
  });

  test("a gate that covers less is flagged; one that ends sooner too", () => {
    expect(change({ agentKey: "dev" })).toMatchObject({
      impact: "loosened",
      warning: true,
    });
    expect(change({ installationName: "ci" })?.summary).toBe(
      "installation any → ci",
    );
    expect(
      change({ resource: { kind: "command", match: "any" } })?.impact,
    ).toBe("tightened");
    expect(change({ expiresAt: "2030-01-01T00:00:00Z" })).toMatchObject({
      impact: "loosened",
      warning: true,
    });
  });

  test("several requirements for one agent compare as a whole", () => {
    const two = [
      { agent: "qa", verdicts: ["pass"], since: [] },
      { agent: "qa", verdicts: ["ok"], since: [] },
    ];
    expect(change({ requires: two })?.impact).toBe("needs_review");
    expect(
      change({ requires: [...two].reverse() }, { requires: two }),
    ).toBeUndefined();
  });

  test("a gate turned into a rule is gone, and the rule is new", () => {
    const { requires: _requires, ...rule } = base;
    const changes = permissionChanges(
      { version: 2, rules: [], gates: [base], budgets: [] },
      { version: 1, rules: [{ ...rule, effect: "allow" }] },
    );
    expect(
      changes.map(({ entry, impact, warning }) => [entry, impact, warning]),
    ).toEqual([
      ["rule", "granted", false],
      ["gate", "loosened", true],
    ]);
  });
});

describe("whether a new review can meet an allow", () => {
  const rule = (fields: Partial<PolicyRule>): PolicyRule => ({
    id: "r",
    name: "R",
    effect: "allow",
    agentKey: null,
    installationName: null,
    toolKey: "shell",
    operationKey: "command.run",
    resource: { kind: "command", match: "prefix", value: "git " },
    conditions: [],
    expiresAt: null,
    ...fields,
  });
  const withReview = (
    allow: Partial<PolicyRule>,
    review: Partial<PolicyRule>,
  ) =>
    permissionChanges(
      { version: 1, rules: [rule(allow)] },
      {
        version: 1,
        rules: [
          rule(allow),
          rule({ id: "ask", effect: "require_approval", ...review }),
        ],
      },
    )[0]?.impact;

  test.each([
    [
      { resource: { kind: "command", match: "exact", value: "git log" } },
      "changed",
    ],
    [{ resource: { kind: "command", match: "exact", value: "ls" } }, "granted"],
    [{ toolKey: "files", operationKey: "file.read" }, "granted"],
  ] as const)("%j is %s", (review, expected) => {
    expect(withReview({}, review as Partial<PolicyRule>)).toBe(expected);
  });

  test("an exact allow and a prefix review", () => {
    const exact = {
      resource: { kind: "command", match: "exact", value: "git log" },
    } as const;
    expect(withReview(exact, {})).toBe("changed");
    expect(
      withReview(exact, {
        resource: { kind: "command", match: "exact", value: "ls" },
      }),
    ).toBe("granted");
  });
});
