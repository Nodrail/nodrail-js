import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { simulate } from "../src/index";
import {
  compilePolicies,
  renderPolicies,
  type CompileResult,
} from "../src/yaml";

const yaml = (text: string, name = "rules.yaml") => ({ name, text });

const ok = (result: CompileResult) => {
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result;
};

const issuesOf = (result: CompileResult) => {
  if (result.ok) throw new Error("expected problems");
  return result.issues;
};

const compile = (...texts: string[]) =>
  compilePolicies(texts.map((text, index) => yaml(text, `f${index}.yaml`)));

const refund = `
- rule: Refunds
  tool: stripe
  operation: refunds.create
  resource: { kind: invoice, match: any }
  effect: require_approval
`;

const call = (operationKey: string, resourceId: string, params = {}) => ({
  agentId: "a",
  installationId: "b",
  toolKey: "stripe",
  operationKey,
  resourceKind: "invoice",
  resourceId,
  params,
});

const now = new Date("2026-11-09T12:00:00.000Z");

const outcome = (
  result: CompileResult,
  descriptor = call("refunds.create", "I"),
) => simulate({ document: ok(result).document, descriptor, now }).outcome;

describe("a rules file", () => {
  test("compiles to the one policy document", () => {
    const { document, rules } = ok(compile(refund));
    expect(document).toEqual({
      version: 1,
      rules: [
        {
          id: "refunds",
          name: "Refunds",
          effect: "require_approval",
          agentKey: null,
          installationName: null,
          toolKey: "stripe",
          operationKey: "refunds.create",
          resource: { kind: "invoice", match: "any" },
          conditions: [],
          expiresAt: null,
        },
      ],
    });
    expect(rules[0]?.source).toEqual({ file: "f0.yaml", line: 2 });
  });

  test("an empty file is no rules", () => {
    expect(ok(compile("")).document.rules).toEqual([]);
  });

  test("a stable id can be set, and is kept when the name changes", () => {
    const named = (name: string) => `
- rule: ${name}
  id: stable-id
  tool: stripe
  operation: refunds.create
  resource: { kind: invoice, match: any }
  effect: deny
`;
    expect(ok(compile(named("One"))).document.rules[0]?.id).toBe("stable-id");
    expect(ok(compile(named("Two"))).document.rules[0]?.id).toBe("stable-id");
  });

  test("agent, installation, expiry, description and tags come through", () => {
    const { document, rules } = ok(
      compile(`
- rule: Scoped
  desc: Why it exists
  tool: stripe
  operation: refunds.create
  resource: { kind: invoice, match: any }
  effect: allow
  agent: billing
  installation: billing-prod
  expires: 2027-01-01T00:00:00Z
  tags: [money]
`),
    );
    expect(document.rules[0]).toMatchObject({
      agentKey: "billing",
      installationName: "billing-prod",
      expiresAt: "2027-01-01T00:00:00Z",
    });
    expect(rules[0]).toMatchObject({
      description: "Why it exists",
      tags: ["money"],
    });
  });

  test("YAML's implicit booleans do not change values", () => {
    const { document } = ok(
      compile(`
- list: countries
  items: [no, yes, "NO"]
- rule: Countries
  tool: stripe
  operation: refunds.create
  resource: { kind: invoice, match: any }
  condition:
    - { field: country, op: in, list: countries }
  effect: allow
`),
    );
    expect(document.rules[0]?.conditions[0]?.value).toEqual([
      "no",
      "yes",
      "NO",
    ]);
  });
});

describe("lists and macros", () => {
  test("a macro expands inside a rule, and can use another macro", () => {
    const result = compile(`
- macro: big
  condition:
    - { field: amount, op: gt, value: 1000 }
- macro: big_usd
  condition:
    - macro: big
    - { field: currency, op: eq, value: USD }
- rule: Large
  tool: stripe
  operation: refunds.create
  resource: { kind: invoice, match: any }
  condition:
    - macro: big_usd
  effect: deny
`);
    expect(ok(result).document.rules[0]?.conditions).toEqual([
      { field: "amount", op: "gt", value: 1000 },
      { field: "currency", op: "eq", value: "USD" },
    ]);
  });

  test("definitions can come after the rule that uses them", () => {
    expect(
      compile(`
- rule: Early
  tool: stripe
  operation: refunds.create
  resource: { kind: invoice, match: any }
  condition:
    - macro: later
  effect: deny
- macro: later
  condition:
    - { field: a, op: eq, value: 1 }
`).ok,
    ).toBe(true);
  });

  test("a resource list becomes one exact rule per item", () => {
    const result = compile(`
- list: invoices
  items: [INV-1, INV-2]
- rule: Listed
  tool: stripe
  operation: refunds.create
  resource: { kind: invoice, list: invoices }
  effect: allow
`);
    expect(ok(result).document.rules.map((rule) => rule.resource)).toEqual([
      { kind: "invoice", match: "exact", value: "INV-1" },
      { kind: "invoice", match: "exact", value: "INV-2" },
    ]);
    expect(outcome(result, call("refunds.create", "INV-2"))).toBe("allow");
    expect(outcome(result, call("refunds.create", "INV-3"))).toBe("none");
  });

  test("each list item keeps its id when the list is reordered", () => {
    const idsByItem = (items: string) =>
      Object.fromEntries(
        ok(
          compile(`
- list: l
  items: [${items}]
- rule: R
  tool: stripe
  operation: refunds.create
  resource: { kind: invoice, list: l }
  effect: allow
`),
        ).document.rules.map((rule) => [rule.resource.value, rule.id]),
      );
    expect(idsByItem("a, b")).toEqual(idsByItem("b, a"));
  });

  test("a switched-off rule still counts as using its list", () => {
    expect(
      compile(`
- list: l
  items: [a]
- rule: R
  enabled: false
  tool: stripe
  operation: refunds.create
  resource: { kind: invoice, list: l }
  effect: allow
`).warnings,
    ).toEqual([]);
  });

  test("something defined but unused is a warning", () => {
    expect(
      compile(`
- list: spare
  items: [a]
`).warnings[0]?.message,
    ).toContain('List "spare"');
  });

  test.each([
    ["macro", `- { macro: nope }`, "Unknown macro"],
    ["list", `- { field: a, op: in, list: nope }`, "Unknown list"],
  ])("an unknown %s is an error", (_label, entry, message) => {
    const issues = issuesOf(
      compile(`
- rule: R
  tool: stripe
  operation: refunds.create
  resource: { kind: invoice, match: any }
  condition:
    ${entry}
  effect: deny
`),
    );
    expect(issues[0]?.message).toContain(message);
  });

  test("a macro that refers to itself is an error, not a hang", () => {
    const issues = issuesOf(
      compile(`
- macro: a
  condition:
    - macro: b
- macro: b
  condition:
    - macro: a
- rule: R
  tool: stripe
  operation: refunds.create
  resource: { kind: invoice, match: any }
  condition:
    - macro: a
  effect: deny
`),
    );
    expect(issues[0]?.message).toContain("refers to itself");
  });
});

describe("files built to do harm or nothing", () => {
  test("nested macros stop at the limit instead of filling memory", () => {
    const fan = Array.from({ length: 20 }, () => "    - macro: m").join("\n");
    let text =
      "- macro: m0\n  condition:\n    - { field: a, op: eq, value: 1 }\n";
    for (let level = 1; level < 12; level += 1)
      text += `- macro: m${level}\n  condition:\n${fan.replaceAll("macro: m", `macro: m${level - 1}`)}\n`;
    text +=
      "- rule: R\n  command: ls\n  condition:\n    - macro: m11\n  effect: deny\n";
    const started = performance.now();
    const issues = issuesOf(compile(text));
    expect(performance.now() - started).toBeLessThan(1000);
    expect(issues.map((issue) => issue.message).join()).toContain(
      "20 conditions",
    );
  });

  test.each([
    ["command", "command: { list: blocked }"],
    [
      "resource",
      "tool: a\n  operation: b.c\n  resource: { kind: k, list: blocked }",
    ],
  ])("an empty list can't quietly delete a %s rule", (_label, body) => {
    const issues = issuesOf(
      compile(
        `- list: blocked\n  items: []\n- rule: R\n  ${body}\n  effect: deny\n`,
      ),
    );
    expect(issues[0]?.message).toContain("empty");
  });

  test("two rules with one long name survive export and import", () => {
    const name = "x".repeat(120);
    const rule = {
      name,
      effect: "deny" as const,
      agentKey: null,
      installationName: null,
      toolKey: "a",
      operationKey: "b.c",
      resource: { kind: "k", match: "any" as const },
      conditions: [],
      expiresAt: null,
    };
    const back = ok(
      compilePolicies([
        yaml(
          renderPolicies({
            version: 1,
            rules: [
              { ...rule, id: "one" },
              { ...rule, id: "two" },
            ],
          }),
        ),
      ]),
    ).document.rules;
    expect(back.map((item) => item.name)).toEqual([name, name]);
  });
});

describe("layering files", () => {
  test("a later file can append to a list", () => {
    const base = `
- list: l
  items: [INV-1]
- rule: R
  tool: stripe
  operation: refunds.create
  resource: { kind: invoice, list: l }
  effect: allow
`;
    const result = compile(
      base,
      `
- list: l
  items: [INV-2]
  override: { items: append }
`,
    );
    expect(outcome(result, call("refunds.create", "INV-2"))).toBe("allow");
  });

  test("a later file can add conditions and disable rules", () => {
    const added = compile(
      refund,
      `
- rule: Refunds
  condition:
    - { field: a, op: eq, value: 1 }
  override: { condition: append }
`,
    );
    expect(ok(added).document.rules[0]?.conditions).toHaveLength(1);
    const off = compile(
      refund,
      `
- rule: Refunds
  enabled: false
  override: { enabled: replace }
`,
    );
    expect(ok(off).document.rules).toEqual([]);
  });

  test("order matters: the last file wins", () => {
    const set = (effect: string) => `
- rule: Refunds
  effect: ${effect}
  override: { effect: replace }
`;
    expect(outcome(compile(refund, set("deny"), set("allow")))).toBe("allow");
    expect(outcome(compile(refund, set("allow"), set("deny")))).toBe("deny");
  });

  test("redefining without override is refused", () => {
    const issues = issuesOf(compile(refund, refund));
    expect(issues[0]?.message).toContain("Use override");
    expect(issues[0]?.file).toBe("f1.yaml");
    expect(issues[0]?.message).toContain("f0.yaml");
  });

  test("override with nothing to override is refused", () => {
    expect(
      issuesOf(
        compile(`
- rule: Missing
  effect: deny
  override: { effect: replace }
`),
      )[0]?.message,
    ).toContain("no earlier definition");
  });

  test.each([
    [
      "a field not named in override",
      "effect: deny\n  override: { enabled: replace }\n  enabled: false",
      "not named in override",
    ],
    [
      "override naming an unset field",
      "override: { effect: replace }",
      "not set",
    ],
    [
      "appending a scalar",
      "effect: deny\n  override: { effect: append }",
      "cannot be appended",
    ],
  ])("%s is refused", (_label, body, message) => {
    const issues = issuesOf(compile(refund, `- rule: Refunds\n  ${body}\n`));
    expect(issues.map((issue) => issue.message).join()).toContain(message);
  });
});

describe("writing rules back out", () => {
  const document = {
    version: 1 as const,
    rules: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        name: "Same name",
        effect: "deny" as const,
        agentKey: "bot",
        installationName: "bot-dev",
        toolKey: "stripe",
        operationKey: "refunds.create",
        resource: { kind: "invoice", match: "prefix" as const, value: "INV-" },
        conditions: [{ field: "amount", op: "gt" as const, value: 5 }],
        expiresAt: "2027-01-01T00:00:00Z",
      },
      {
        id: "22222222-2222-4222-8222-222222222222",
        name: "Same name",
        effect: "allow" as const,
        agentKey: null,
        installationName: null,
        toolKey: "stripe",
        operationKey: "invoices.get",
        resource: { kind: "invoice", match: "any" as const },
        conditions: [],
        expiresAt: null,
      },
    ],
  };

  test("compiles back to the same rules", () => {
    const back = ok(compilePolicies([yaml(renderPolicies(document))])).document;
    expect(back.rules.map((rule) => ({ ...rule, name: "" }))).toEqual(
      document.rules.map((rule) => ({ ...rule, name: "" })),
    );
  });

  test("no rules is still a valid file", () => {
    expect(
      ok(compilePolicies([yaml(renderPolicies({ version: 1, rules: [] }))]))
        .document.rules,
    ).toEqual([]);
  });

  test("hostile names cannot become YAML structure", () => {
    const name = 'x"\n- rule: injected\n  effect: allow';
    const [rule] = document.rules;
    const text = renderPolicies({
      version: 1,
      rules: [{ ...(rule as (typeof document.rules)[0]), name }],
    });
    expect(ok(compilePolicies([yaml(text)])).document.rules).toHaveLength(1);
  });
});

describe("reporting problems", () => {
  test("every problem has its own file and line", () => {
    const issues = issuesOf(
      compile(`- rule: One
  tool: stripe
  operation: refunds.create
  resource: { kind: invoice, match: any }
  effect: maybe
- rule: Two
  tool: BAD TOOL
  operation: refunds.create
  resource: { kind: invoice, match: any }
  effect: deny
`),
    );
    expect(issues.map((issue) => issue.line)).toEqual([1, 6]);
    expect(issues[0]?.message).toContain('Rule "One" effect');
  });

  test.each([
    ["broken YAML", "- rule: [", ""],
    ["duplicate keys", "- rule: a\n  rule: b\n", "unique"],
    ["not a list", "rule: a\n", "is a list of"],
    ["an unknown entry", "- nonsense: 1\n", "Expected a list"],
    ["an unknown field", "- rule: a\n  surprise: 1\n", "surprise"],
    ["a missing field", "- rule: a\n  tool: x\n", "needs"],
    ["a newer format", "- required_engine_version: 99\n", "engine version 99"],
  ])("%s is reported", (_label, text, message) => {
    const issues = issuesOf(compile(text));
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.map((issue) => issue.message).join()).toContain(message);
  });

  test("a huge file is refused before parsing", () => {
    expect(
      issuesOf(compile("#".repeat(1024 * 1024 + 1)))[0]?.message,
    ).toContain("1 MB");
  });

  test("an alias bomb is refused", () => {
    const bomb = `
- &a [x, x, x, x, x, x, x, x, x]
- &b [*a, *a, *a, *a, *a, *a, *a, *a, *a]
- &c [*b, *b, *b, *b, *b, *b, *b, *b, *b]
- &d [*c, *c, *c, *c, *c, *c, *c, *c, *c]
- &e [*d, *d, *d, *d, *d, *d, *d, *d, *d]
- &f [*e, *e, *e, *e, *e, *e, *e, *e, *e]
`;
    expect(issuesOf(compile(bomb))[0]?.message).toContain("aliases");
  });

  test("more than the engine's limit of rules is refused", () => {
    const items = Array.from({ length: 501 }, (_, i) => `R${i}`).join(", ");
    const issues = issuesOf(
      compile(`
- list: many
  items: [${items.split(", ").slice(0, 500).join(", ")}]
- list: more
  items: [x]
- rule: A
  tool: stripe
  operation: refunds.create
  resource: { kind: invoice, list: many }
  effect: allow
- rule: B
  tool: stripe
  operation: refunds.create
  resource: { kind: invoice, list: more }
  effect: allow
`),
    );
    expect(issues.length).toBeGreaterThan(0);
  });
});

describe("the same engine", () => {
  const base = readFileSync(
    new URL("../examples/rules/base.yaml", import.meta.url),
    "utf8",
  );

  test("deny beats review beats allow, written in YAML", () => {
    const rule = (name: string, effect: string) => `
- rule: ${name}
  tool: stripe
  operation: refunds.create
  resource: { kind: invoice, match: any }
  effect: ${effect}
`;
    expect(
      outcome(compile(rule("A", "allow"), rule("B", "require_approval"))),
    ).toBe("require_approval");
    expect(outcome(compile(rule("A", "allow"), rule("B", "deny")))).toBe(
      "deny",
    );
  });

  test("a wrong-typed parameter gets no help from YAML rules", () => {
    // "5" looks small, but only a real number can satisfy the allow rule.
    expect(
      outcome(
        compile(base),
        call("refunds.create", "I", { amount: "5", currency: "USD" }),
      ),
    ).toBe("require_approval");
  });
});

describe("the package boundary", () => {
  const source = new URL("../src/", import.meta.url).pathname;
  const allowed = /^(\.\/|node:|zod$|yaml$|canonicalize$)/;

  test.each(readdirSync(source))(
    "%s imports nothing from the product",
    (file) => {
      const text = readFileSync(join(source, file), "utf8");
      for (const [, target = ""] of text.matchAll(/from "([^"]+)"/g))
        expect(target).toMatch(allowed);
    },
  );

  test("the evaluator needs no Node or YAML", () => {
    const text = readFileSync(join(source, "evaluator.ts"), "utf8");
    expect(text).not.toMatch(/from "(node:|yaml)/);
  });
});
