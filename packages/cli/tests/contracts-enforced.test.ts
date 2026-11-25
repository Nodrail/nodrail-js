// Briefs and operation inputs enforced by the local hook:
// the effective policy carries them with the rules' `where`, so the hook
// that `apply` sets up refuses a dispatch without a valid brief and a call
// whose arguments don't conform, and rules read the checked values. Also:
// the object form of spec.brief, header briefs and header findings counts
// in render/validate/explain, and plan's warning for a `where` Cloud can't
// read.
import { join } from "node:path";
import { parse } from "yaml";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  fileOf,
  hookDocument,
  locked,
  planFor,
  RESOURCES,
} from "./support/setup-project.ts";

const api = "apiVersion: nodrail.com/v1alpha1";

const CONTRACTS = `shapes:
  review:
    properties:
      verdict: { values: [ship, fix-first], role: verdict }
      findings:
        role: findings
        report: true
        properties:
          blocker: { type: integer, min: 0 }
          major: { type: integer, min: 0 }
  work-brief:
    properties:
      issue: { type: string, max: 40, report: true }
      budget: { type: integer, min: 1, max: 500 }
  refund-args:
    properties:
      amount: { type: integer, min: 1, report: true }
      environment: { values: [staging, production] }
receipts:
  reviewer: { shape: review, format: header, header: { title: "RECEIPT {agent}" } }
connections:
  pay:
    command: ${JSON.stringify(process.execPath)}
    args: [./pay.cjs]
    operations:
      refund: { input: refund-args }
`;

const RULES = `- required_engine_version: 4
- rule: Start agents
  tool: claude-code
  operation: agent
  resource: { kind: agent, match: any }
  effect: allow
- rule: Publisher never on a big budget
  tool: claude-code
  operation: agent
  resource: { kind: agent, match: exact, value: publisher }
  where: { brief.budget: { min: 101 } }
  effect: deny
- rule: Small refunds in staging
  tool: pay
  operation: refund
  resource: { kind: mcp_tool, match: any }
  where: { input.amount: { max: 5000 }, input.environment: staging }
  effect: allow
`;

const FILES = {
  ...RESOURCES,
  "resources/agents.yaml": RESOURCES["resources/agents.yaml"].replace(
    `${api}\nkind: Agent\nmetadata: { name: publisher }`,
    `${api}
kind: Agent
metadata: { name: publisher }
spec:
  receipt: reviewer
  brief: { shape: work-brief, format: header, header: { aliases: { ticket: issue } } }`,
  ),
  "policies/contracts.yaml": RULES,
  // Never started here: the hook judges the call before any provider.
  "pay.cjs": "process.exit(0);\n",
  "nodrail.yaml": `${RESOURCES["nodrail.yaml"]}  - ./policies/contracts.yaml\n${CONTRACTS}`,
};

const EFFECTIVE = ".nodrail/effective.yaml";

async function setUp() {
  const p = await locked(FILES);
  const text = fileOf(planFor(p, "claude-code"), EFFECTIVE);
  p.write(EFFECTIVE, text);
  return { p, text };
}

describe("the effective policy", () => {
  test("carries the brief as declared, the operation input and the rules' where", async () => {
    const { text } = await setUp();
    const contracts = (parse(text) as Record<string, any>[])[1]!.contracts;
    expect(contracts.agents.publisher).toEqual({
      receipt: "reviewer",
      brief: {
        shape: "work-brief",
        format: "header",
        header: { aliases: { ticket: "issue" } },
      },
    });
    expect(contracts.connections).toEqual({
      pay: { operations: { refund: { input: "refund-args" } } },
    });
    expect(Object.keys(contracts.shapes)).toEqual([
      "review",
      "work-brief",
      "refund-args",
    ]);
    const document = hookDocument(text);
    expect(Object.keys(document.briefs)).toEqual(["publisher"]);
    expect(Object.keys(document.inputs)).toEqual(["pay.refund"]);
  });
});

describe("the hook enforces briefs and inputs", () => {
  afterEach(() => vi.unstubAllEnvs());

  test("a dispatch needs a valid brief, and a call conforming arguments; where reads both", async () => {
    const { p } = await setUp();
    vi.stubEnv("NODRAIL_LEDGER", join(p.cwd, ".ledger"));
    const decide = async (tool: string, input: object) => {
      const { out, code } = await p.runWith(
        {
          stdin: JSON.stringify({
            session_id: `enforced-${Date.now()}`,
            cwd: p.cwd,
            hook_event_name: "PreToolUse",
            tool_name: tool,
            tool_input: input,
          }),
        },
        "policy",
        "hook",
        join(p.cwd, EFFECTIVE),
        "--agent",
        "lead",
      );
      expect(code).toBe(0);
      return out
        ? JSON.parse(out).hookSpecificOutput
        : { permissionDecision: "allow" };
    };
    const start = (prompt: string) =>
      decide("Agent", {
        subagent_type: "publisher",
        description: "go",
        prompt,
      });
    expect(
      (await start("Publish.\nagent: publisher\nticket: ENG-1\nbudget: 80\n"))
        .permissionDecision,
    ).toBe("allow");
    // Valid, but the rule's where denies a big budget.
    expect(
      (await start("Publish.\nticket: ENG-1\nbudget: 200\n"))
        .permissionDecision,
    ).toBe("deny");
    const missing = await start("Publish the notes, please.");
    expect(missing.permissionDecision).toBe("deny");
    expect(missing.permissionDecisionReason).toContain(
      "the brief for publisher doesn't follow its contract",
    );
    expect(
      (await start("ticket: ENG-1\nbudget: 80\nagent: lead\n"))
        .permissionDecision,
    ).toBe("deny");
    const refund = (args: object) => decide("mcp__pay__refund", args);
    expect(
      (await refund({ amount: 1200, environment: "staging" }))
        .permissionDecision,
    ).toBe("allow");
    const invalid = await refund({
      amount: 0,
      environment: "staging",
      note: "secret-note",
    });
    expect(invalid.permissionDecision).toBe("deny");
    expect(invalid.permissionDecisionReason).not.toContain("secret-note");
    expect(
      (await refund({ amount: 1200, environment: "production" }))
        .permissionDecision,
    ).not.toBe("allow");
  });
});

describe("render, validate and explain", () => {
  test("a header brief is rendered as lines and read back with the engine's reader", async () => {
    const { p } = await setUp();
    const lead = fileOf(planFor(p, "claude-code"), ".claude/agents/lead.md");
    expect(lead).toContain("Give it as `key: value` lines in the prompt");
    expect(lead).toContain(
      "- `ticket` (required): text, at most 40 characters.",
    );
    const example = /```text\n(agent: publisher[\s\S]*?)\n```/.exec(lead)![1]!;
    expect(example).toBe("agent: publisher\nticket: example\nbudget: 1");
    p.write("samples/dispatch.md", `Publish.\n\n${example}\n`);
    expect(
      (
        await p.run(
          "contracts",
          "validate",
          "brief:publisher",
          "samples/dispatch.md",
        )
      ).code,
    ).toBe(0);
    p.write("samples/other.md", "ticket: ENG-1\nbudget: 900\n");
    const bad = await p.run(
      "contracts",
      "validate",
      "brief:publisher",
      "samples/other.md",
    );
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("budget: above");
    const explain = (await p.run("contracts", "explain", "brief:publisher"))
      .out;
    expect(explain).toContain("Format: header, `key: value` lines");
  });

  test("findings counts are written `0 blocker / 1 major` in a header receipt", async () => {
    const { p } = await setUp();
    const section = (await p.run("contracts", "render", "publisher")).out;
    expect(section).toContain(
      "one line of counts, `<count> <category>` separated by ` / `",
    );
    expect(section).toContain("findings: 0 blocker / 0 major");
    p.write(
      "samples/receipt.md",
      "Reviewed.\n\nRECEIPT publisher\nverdict: SHIP\nfindings: 0 blocker / 1 major\n",
    );
    const read = await p.run(
      "contracts",
      "validate",
      "receipt:reviewer",
      "samples/receipt.md",
    );
    expect(read.code).toBe(0);
    expect(read.out).toContain(
      "Read as the hook reads it: verdict ship, 1 finding (0 blocker / 1 major)",
    );
    const json = await p.run(
      "--json",
      "contracts",
      "validate",
      "receipt:reviewer",
      "samples/receipt.md",
    );
    expect(JSON.parse(json.out)).toMatchObject({
      findings: 1,
      findingsLine: "0 blocker / 1 major",
    });
    const explain = (await p.run("contracts", "explain", "receipt:reviewer"))
      .out;
    expect(explain).toContain(
      "findings: required, counts of blocker, major (a header line writes them `0 blocker / 1 major`), role findings, reported",
    );
  });

  test("plan and explain say which where Cloud can't read (fail-closed)", async () => {
    const { p } = await setUp();
    const notes = planFor(p, "claude-code").notes.join("\n");
    expect(notes).toContain(
      "In Nodrail Cloud, a where reads only reported fields",
    );
    expect(notes).toContain(
      'rule "Publisher never on a big budget": where brief.budget, but brief:publisher doesn\'t report budget',
    );
    expect(notes).toContain(
      'rule "Small refunds in staging": where input.environment, but input:pay.refund doesn\'t report environment',
    );
    expect(notes).not.toContain("where input.amount");
    const explain = (await p.run("contracts", "explain", "input:pay.refund"))
      .out;
    expect(explain).toContain(
      'rule "Small refunds in staging": input.amount is at most 5000; input.environment is staging (not reported, so never met in Nodrail Cloud)',
    );
  });
});
