// Properties the engine must keep for any input, checked against thousands of
// generated cases. These are the guarantees the security model states.
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { describeToolCall } from "../src/actions.js";
import { classifyCommand } from "../src/commands.js";
import { simulate } from "../src/simulator.js";
import { compilePolicies } from "../src/yaml.js";

const runs = { numRuns: 300 };
const now = new Date("2026-11-10T12:00:00.000Z");

describe("describing a call", () => {
  const toolNames = fc.oneof(
    fc.constantFrom("Bash", "Write", "Edit", "Read", "Grep", "Glob", "WebFetch", "WebSearch", "apply_patch", "mcp__github__create_issue"),
    fc.string(),
  );

  test("any call is described or refused, never a crash", () => {
    fc.assert(
      fc.property(toolNames, fc.dictionary(fc.string(), fc.jsonValue()), fc.option(fc.string()), (name, input, cwd) => {
        const action = describeToolCall(name, input, cwd ?? undefined);
        if (action) expect(action.resource.id.length).toBeLessThanOrEqual(600);
      }),
      runs,
    );
  });

  test("a token anywhere in a command never leaves the machine", () => {
    const token = fc.stringMatching(/^[A-Za-z0-9]{36}$/).map((body) => `ghp_${body}`);
    fc.assert(
      fc.property(fc.string(), token, fc.string(), fc.constantFrom(" ", "=", ":", "\n", "'"), (before, secret, after, gap) => {
        const action = describeToolCall("Bash", { command: `${before}${gap}${secret}${gap}${after}` });
        expect(JSON.stringify(action ?? {})).not.toContain(secret);
      }),
      runs,
    );
  });
});

describe("commands", () => {
  const word = fc.stringMatching(/^[a-z]{1,8}$/);
  const simple = fc.array(word, { minLength: 1, maxLength: 4 }).map((words) => words.join(" "));

  test("two commands joined are never one simple command", () => {
    fc.assert(
      fc.property(simple, fc.constantFrom(";", "&&", "||", "|", "\n", "&"), simple, (left, join, right) => {
        expect(classifyCommand(`${left} ${join} ${right}`).operation).not.toBe("command.run");
      }),
      runs,
    );
  });
});

describe("rules", () => {
  const effects = ["allow", "require_approval", "deny"] as const;
  const values = fc.stringMatching(/^[ab]{0,3}$/);
  const rule = fc.record({
    effect: fc.constantFrom(...effects),
    match: fc.constantFrom("any", "exact", "prefix"),
    value: values.filter((value) => value.length > 0),
  });

  const yamlOf = (rules: { effect: string; match: string; value: string }[]) =>
    rules
      .map(
        (item, index) => `- rule: Rule ${index}
  tool: t
  operation: o
  resource: { kind: k, match: ${item.match}${item.match === "any" ? "" : `, value: "${item.value}"`} }
  effect: ${item.effect}`,
      )
      .join("\n\n");

  // An independent statement of precedence: deny, then review, then allow.
  const expected = (rules: { effect: string; match: string; value: string }[], id: string) => {
    const matching = rules.filter(
      (item) =>
        item.match === "any" ||
        (item.match === "exact" && id === item.value) ||
        (item.match === "prefix" && id.startsWith(item.value)),
    );
    for (const effect of ["deny", "require_approval", "allow"])
      if (matching.some((item) => item.effect === effect)) return effect;
    return "none";
  };

  test("deny beats review beats allow, and no match is never an allow", () => {
    fc.assert(
      fc.property(fc.array(rule, { maxLength: 6 }), values.filter((id) => id.length > 0), (rules, id) => {
        const compiled = compilePolicies([{ name: "rules.yaml", text: yamlOf(rules) || "[]" }]);
        if (!compiled.ok) throw new Error(JSON.stringify(compiled.issues));
        const { outcome } = simulate({
          document: compiled.document,
          descriptor: { agentId: "a", installationId: "i", toolKey: "t", operationKey: "o", resourceKind: "k", resourceId: id, params: {} },
          now,
        });
        expect(outcome).toBe(expected(rules, id));
      }),
      runs,
    );
  });
});
