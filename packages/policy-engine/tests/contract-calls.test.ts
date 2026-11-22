// Briefs (DC-02.1) and tool inputs (DC-02.2) through `nodrail-policy hook`:
// the brief an agent is started with and the arguments of a connection
// operation, checked against their declared contracts on the exact call,
// before any rule; typed `where` on rules and gates reads the valid value.
// A refused call never runs: the hook's answer is a deny, so the host never
// starts the agent or calls the provider.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { checkContracts } from "../src/contract-calls";
import { describeToolCall } from "../src/actions";
import { readBrief, type BriefContract } from "../src/shapes/brief";
import { checkInput } from "../src/shapes/inputs";
import { compilePolicies, renderPolicies } from "../src/yaml";
import { cli, homeAt } from "./run-cli.ts";

const CONTRACTS = `- required_engine_version: 4
- contracts:
    shapes:
      refund-args:
        properties:
          amount: { type: integer, min: 1, unit: usd_cents }
          currency: { values: [usd, eur] }
          environment: { values: [staging, production] }
          card_token: { type: string, max: 64, classification: secret, optional: true }
      work-brief:
        properties:
          issue: { type: string, max: 40 }
          budget: { type: integer, min: 1, max: 500 }
    agents:
      dev: { brief: work-brief }
      lease:
        brief:
          shape: work-brief
          format: header
          header: { aliases: { ticket: issue } }
    connections:
      stripe:
        operations:
          refund: { input: refund-args }
`;

const RULES = `${CONTRACTS}- rule: Small refunds in staging
  tool: stripe
  operation: refund
  resource: { kind: mcp_tool, match: any }
  where: { input.amount: { max: 5000 }, input.environment: staging }
  effect: allow
- rule: Never refund large amounts
  tool: stripe
  operation: refund
  resource: { kind: mcp_tool, match: any }
  where: { input.amount: { min: 5001 } }
  effect: deny
- rule: Never refund in production
  tool: stripe
  operation: refund
  resource: { kind: mcp_tool, match: any }
  where: { input.environment: production }
  effect: deny
- rule: Start agents
  tool: claude-code
  operation: agent
  resource: { kind: agent, match: any }
  effect: allow
- rule: Dev never on a big budget
  tool: claude-code
  operation: agent
  resource: { kind: agent, match: exact, value: dev }
  where: { brief.budget: { min: 101 } }
  effect: deny
`;

function rulesFile(text = RULES) {
  const folder = mkdtempSync(join(tmpdir(), "nodrail-calls-"));
  const file = join(folder, "rules.yaml");
  writeFileSync(file, text);
  return { folder, file };
}

type Answer = { permissionDecision: string; permissionDecisionReason: string };

async function hook(
  event: object,
  { text = RULES, host = [] as string[] } = {},
): Promise<Answer> {
  const { folder, file } = rulesFile(text);
  // The run ledger of a folder outside git is in the home: a fresh one, so
  // no earlier run's history decides these calls.
  const restore = homeAt(mkdtempSync(join(tmpdir(), "nodrail-home-")));
  const sent = await cli(
    ["hook", file, ...host],
    JSON.stringify({ session_id: "s", cwd: folder, ...event }),
  ).finally(restore);
  expect(sent.code).toBe(0);
  if (!sent.stdout)
    return { permissionDecision: "allow", permissionDecisionReason: "" };
  const parsed = JSON.parse(sent.stdout) as {
    hookSpecificOutput?: Answer;
    permissionDecision?: string;
    permissionDecisionReason?: string;
  };
  return (
    parsed.hookSpecificOutput ?? {
      permissionDecision: parsed.permissionDecision!,
      permissionDecisionReason: parsed.permissionDecisionReason!,
    }
  );
}

const refund = (input: Record<string, unknown>) => ({
  hook_event_name: "PreToolUse",
  tool_name: "mcp__stripe__refund",
  tool_input: input,
});

const dispatch = (type: string, prompt: string) => ({
  hook_event_name: "PreToolUse",
  tool_name: "Agent",
  tool_input: { subagent_type: type, description: "work", prompt },
});

const brief = (body: string) =>
  `Fix the login bug.\n\n\`\`\`nodrail-brief\n${body}\n\`\`\`\n`;

describe(
  "tool input (S03) checked before the provider is called",
  { timeout: 60_000 },
  () => {
    test("a valid small refund in staging is allowed by its typed where", async () => {
      const answer = await hook(
        refund({ amount: 1200, currency: "usd", environment: "staging" }),
      );
      expect(answer.permissionDecision).toBe("allow");
    });

    test("a large refund is denied by its typed where", async () => {
      const answer = await hook(
        refund({ amount: 9000, currency: "usd", environment: "staging" }),
      );
      expect(answer.permissionDecision).toBe("deny");
      expect(answer.permissionDecisionReason).toContain(
        "never-refund-large-amounts",
      );
    });

    test("the wrong environment is denied by its rule", async () => {
      const answer = await hook(
        refund({ amount: 1200, currency: "usd", environment: "production" }),
      );
      expect(answer.permissionDecision).toBe("deny");
      expect(answer.permissionDecisionReason).toContain(
        "never-refund-in-production",
      );
    });

    test("an invalid amount is denied before any rule, and never echoed", async () => {
      const answer = await hook(
        refund({ amount: "1200", currency: "usd", environment: "staging" }),
      );
      expect(answer.permissionDecision).toBe("deny");
      expect(answer.permissionDecisionReason).toContain(
        "the input of stripe refund doesn't follow its contract: amount: expected integer",
      );
      expect(answer.permissionDecisionReason).toContain("never reaches stripe");
      expect(answer.permissionDecisionReason).not.toContain("1200");
    });

    test("an argument the contract doesn't declare is refused (strict)", async () => {
      const answer = await hook(
        refund({
          amount: 10,
          currency: "usd",
          environment: "staging",
          note: "x",
        }),
      );
      expect(answer.permissionDecision).toBe("deny");
      expect(answer.permissionDecisionReason).toContain("note: not declared");
    });

    test("an out-of-range value is refused with its bound, not its value", async () => {
      const answer = await hook(
        refund({ amount: 0, currency: "gbp", environment: "staging" }),
      );
      expect(answer.permissionDecisionReason).toContain(
        "amount: expected at least 1",
      );
      expect(answer.permissionDecisionReason).toContain(
        "currency: expected one of usd, eur",
      );
      expect(answer.permissionDecisionReason).not.toContain("gbp");
    });

    test("a secret argument is never shown: not in a refusal, not to reviewers", async () => {
      const secret = "tok_live_" + "x".repeat(70);
      const refused = await hook(
        refund({
          amount: 10,
          currency: "usd",
          environment: "staging",
          card_token: secret,
        }),
      );
      expect(refused.permissionDecision).toBe("deny");
      expect(refused.permissionDecisionReason).toContain(
        "card_token: expected at most 64 characters",
      );
      expect(refused.permissionDecisionReason).not.toContain("tok_live");

      const compiled = compilePolicies([{ name: "r.yaml", text: RULES }]);
      if (!compiled.ok) throw new Error("rules don't compile");
      const input = {
        amount: 10,
        currency: "usd",
        environment: "staging",
        card_token: "tok_1",
      };
      const action = describeToolCall("mcp__stripe__refund", input)!;
      const checked = checkContracts(compiled.document, action, input);
      if ("refusal" in checked) throw new Error(checked.refusal);
      expect(checked.values).toEqual({ input });
      expect(JSON.stringify(checked.action.params)).not.toContain("tok_1");
      expect(checked.action.params.input).toMatchObject({
        card_token: "[classified]",
      });
      // The fingerprint still binds the exact call reviewed and run.
      expect(checked.action.params.input_sha256).toBe(
        action.params.input_sha256,
      );

      const valid = await hook(refund(input));
      expect(valid.permissionDecision).toBe("allow");
    });

    test("an input over 16 KiB is refused as size", () => {
      const compiled = compilePolicies([{ name: "r.yaml", text: RULES }]);
      if (!compiled.ok || compiled.document.version !== 3)
        throw new Error("no v3");
      const contract = compiled.document.inputs!["stripe.refund"]!;
      expect(
        checkInput(contract, {
          amount: 1,
          currency: "usd",
          environment: "x".repeat(17_000),
        }),
      ).toMatchObject({
        state: "invalid",
        issues: [{ path: "(value)", code: "size" }],
      });
    });

    test("a call to another operation has no contract and is decided as before", async () => {
      const answer = await hook({
        hook_event_name: "PreToolUse",
        tool_name: "mcp__stripe__charge",
        tool_input: { anything: 1 },
      });
      expect(answer.permissionDecisionReason).toContain(
        "no rule covers stripe charge",
      );
    });
  },
);

describe(
  "briefs (S02) checked before the agent starts",
  { timeout: 60_000 },
  () => {
    test("a valid fenced brief starts the agent", async () => {
      const answer = await hook(
        dispatch("dev", brief("issue: ENG-1\nbudget: 50")),
      );
      expect(answer.permissionDecision).toBe("allow");
    });

    test("a rule's where reads the brief", async () => {
      const answer = await hook(
        dispatch("dev", brief("issue: ENG-1\nbudget: 150")),
      );
      expect(answer.permissionDecision).toBe("deny");
      expect(answer.permissionDecisionReason).toContain(
        "dev-never-on-a-big-budget",
      );
    });

    test("a missing brief blocks the dispatch, and says how to give one", async () => {
      const answer = await hook(
        dispatch("dev", "Fix the login bug, issue ENG-1."),
      );
      expect(answer.permissionDecision).toBe("deny");
      expect(answer.permissionDecisionReason).toContain(
        "the brief for dev doesn't follow its contract: no nodrail-brief block ends the prompt",
      );
    });

    test("a wrong or missing field blocks it", async () => {
      const wrong = await hook(
        dispatch("dev", brief("issue: ENG-1\nbudget: lots")),
      );
      expect(wrong.permissionDecisionReason).toContain(
        "budget: expected integer",
      );
      const missing = await hook(dispatch("dev", brief("issue: ENG-1")));
      expect(missing.permissionDecisionReason).toContain("budget: required");
    });

    test("the contract is the dispatched agent's, never the one the prompt names", async () => {
      const answer = await hook(
        dispatch("dev", brief("agent: qa\nissue: ENG-1\nbudget: 50")),
      );
      expect(answer.permissionDecision).toBe("deny");
      expect(answer.permissionDecisionReason).toContain(
        "the brief names agent qa, but dev is being started",
      );
      // An agent without a brief contract starts as before, whatever the prompt says.
      expect(
        (await hook(dispatch("qa", brief("budget: 9999")))).permissionDecision,
      ).toBe("allow");
    });

    test("only the block that ends the prompt counts", async () => {
      // A block quoted mid-prompt is an example, not the brief.
      const quoted = `${brief("issue: A\nbudget: 400")}\nThen:\n${brief("issue: B\nbudget: 2")}`;
      expect((await hook(dispatch("dev", quoted))).permissionDecision).toBe(
        "allow",
      );
      const followed = await hook(
        dispatch("dev", `${brief("issue: B\nbudget: 2")}\nThanks.`),
      );
      expect(followed.permissionDecisionReason).toContain(
        "no nodrail-brief block ends the prompt",
      );
    });

    test("the header bridge reads the team's flat lines, opted in", async () => {
      const lease = "Lease for the developer.\nTicket: ENG-7\nBudget: 80\nGo.";
      expect((await hook(dispatch("lease", lease))).permissionDecision).toBe(
        "allow",
      );
      const twice = await hook(dispatch("lease", `${lease}\nBudget: 90`));
      expect(twice.permissionDecisionReason).toContain("budget: given twice");
      const none = await hook(dispatch("lease", "Just do it."));
      expect(none.permissionDecisionReason).toContain(
        "the prompt has none of the brief's lines",
      );
    });

    test("Copilot's task, native or in Claude Code's form, is read by its agent_type", async () => {
      const { folder, file } = rulesFile();
      const home = mkdtempSync(join(tmpdir(), "nodrail-home-"));
      const send = (event: object) => {
        const restore = homeAt(home);
        return cli(
          ["hook", file, "--host", "copilot"],
          JSON.stringify({ sessionId: "s", cwd: folder, ...event }),
        ).finally(restore);
      };
      const big = {
        agent_type: "dev",
        description: "d",
        prompt: brief("issue: A\nbudget: 400"),
      };
      const native = await send({ toolName: "task", toolArgs: big });
      expect(native.stdout).toContain("dev-never-on-a-big-budget");
      // Copilot 1.0.114 runs Claude Code's hook as `Agent` with its own
      // `agent_type`: read as Copilot's task, so dev is dev, not general-purpose.
      process.env.COPILOT_HOOK_DEPTH = "1";
      const restore = homeAt(home);
      try {
        const compat = await cli(
          ["hook", file],
          JSON.stringify({
            session_id: "s",
            cwd: folder,
            hook_event_name: "PreToolUse",
            tool_name: "Agent",
            tool_input: big,
          }),
        );
        expect(compat.stdout).toContain("dev-never-on-a-big-budget");
      } finally {
        delete process.env.COPILOT_HOOK_DEPTH;
        restore();
      }
    });

    test("Codex hands the brief over encrypted: unobservable, so blocked", async () => {
      const answer = await hook(
        {
          hook_event_name: "PreToolUse",
          tool_name: "spawn_agent",
          tool_input: { agent_type: "dev", message: "gAAAAAB-encrypted" },
        },
        {
          text: RULES.replace(
            "- rule: Start agents\n  tool: claude-code",
            "- rule: Start agents on Codex\n  tool: codex\n  operation: agent\n  resource: { kind: agent, match: any }\n  effect: allow\n- rule: Start agents\n  tool: claude-code",
          ),
          host: ["--host", "codex"],
        },
      );
      expect(answer.permissionDecision).toBe("deny");
      expect(answer.permissionDecisionReason).toContain(
        "this host doesn't show the hook the brief it hands over",
      );
    });

    test("readBrief keeps missing, invalid, unobservable and valid apart", () => {
      const compiled = compilePolicies([{ name: "r.yaml", text: RULES }]);
      if (!compiled.ok || compiled.document.version !== 3)
        throw new Error("no v3");
      const contract: BriefContract = compiled.document.briefs!.dev!;
      expect(readBrief(null, contract, "dev").state).toBe("unobservable");
      expect(readBrief("nothing", contract, "dev").state).toBe("missing");
      expect(readBrief(brief("issue: A"), contract, "dev").state).toBe(
        "invalid",
      );
      expect(readBrief(brief("issue: A\nbudget: 3"), contract, "dev")).toEqual({
        state: "valid",
        format: "fenced",
        value: { issue: "A", budget: 3 },
      });
      expect(
        readBrief("```nodrail-brief\nissue: A\nbudget: 3\n", contract, "dev"),
      ).toMatchObject({
        state: "missing",
        issues: [{ path: "(value)", code: "not-final" }],
      });
      const huge = `\`\`\`nodrail-brief\nissue: A\nbudget: 3\nx: ${"y".repeat(17_000)}\n\`\`\`\n`;
      expect(readBrief(huge, contract, "dev")).toMatchObject({
        state: "invalid",
        issues: [{ path: "(value)", code: "size" }],
      });
    });
  },
);

describe("compiling briefs, inputs and where in rule files", () => {
  const compile = (text: string) => compilePolicies([{ name: "r.yaml", text }]);
  const messages = (text: string) => {
    const result = compile(text);
    return result.ok ? [] : result.issues.map((issue) => issue.message);
  };

  test("the document carries each brief and input, pinned, and each where", () => {
    const result = compile(RULES);
    if (!result.ok || result.document.version !== 3) throw new Error("no v3");
    expect(Object.keys(result.document.briefs!)).toEqual(["dev", "lease"]);
    expect(result.document.briefs!.lease).toMatchObject({
      format: "header",
      aliases: { ticket: "issue" },
    });
    expect(result.document.inputs!["stripe.refund"]).toMatchObject({
      name: "input:stripe.refund",
    });
    expect(result.document.rules[0]!.where).toEqual([
      { path: ["input", "amount"], op: "range", min: null, max: 5000 },
      { path: ["input", "environment"], op: "eq", value: "staging" },
    ]);
  });

  test("receipts-only documents carry no briefs, inputs or where", () => {
    const result = compile(
      "- required_engine_version: 4\n- contracts:\n    shapes:\n      r:\n        properties:\n          verdict: { values: [ok], role: verdict }\n    receipts:\n      qa: { shape: r }\n",
    );
    if (!result.ok) throw new Error("no");
    expect(result.document).not.toHaveProperty("briefs");
    expect(result.document).not.toHaveProperty("inputs");
  });

  test("where needs level 4, a contracts entry and declared paths", () => {
    const rule =
      "- rule: R\n  tool: stripe\n  operation: refund\n  resource: { kind: mcp_tool, match: any }\n  where: { input.amount: 5 }\n  effect: allow\n";
    expect(
      messages(`- required_engine_version: 3\n${rule}`).join("\n"),
    ).toContain("need required_engine_version: 4");
    expect(
      messages(`- required_engine_version: 4\n${rule}`).join("\n"),
    ).toContain("declare it in a contracts entry");
    expect(
      messages(RULES + rule.replace("input.amount", "input.amont")).join("\n"),
    ).toContain("No property amont");
    expect(
      messages(
        RULES + rule.replace("input.amount: 5", 'input.amount: "5"'),
      ).join("\n"),
    ).toContain("can't hold for input.amount");
    // A result is read where the call is mediated, never by this hook.
    expect(
      messages(RULES + rule.replace("input.amount", "result.amount")).join(
        "\n",
      ),
    ).toContain("A path starts with one of: input");
  });

  test("a result contract is refused in a rule file", () => {
    expect(
      messages(
        RULES.replace(
          "refund: { input: refund-args }",
          "refund: { input: refund-args, output: refund-args }",
        ),
      ).length,
    ).toBeGreaterThan(0);
  });

  test("a brief's reserved agent, nesting and aliases are checked", () => {
    const shapes = RULES.replace(
      "budget: { type: integer, min: 1, max: 500 }",
      "budget: { type: integer, min: 1, max: 500 }\n          agent: { type: string }",
    );
    expect(messages(shapes).join("\n")).toContain(
      "agent is the dispatch's reserved identity",
    );
    expect(
      messages(RULES.replace("ticket: issue", "ticket: nothing")).join("\n"),
    ).toContain("Alias ticket must name one top-level property");
  });

  test("a gate's where narrows the calls it holds", async () => {
    const text = `${RULES}- gate: Big refunds after review
  tool: stripe
  operation: refund
  resource: { kind: mcp_tool, match: any }
  where: { input.amount: { min: 1000 } }
  requires: [{ agent: reviewer, verdict: ship }]
  otherwise: deny
`;
    const result = compile(text);
    if (!result.ok || result.document.version !== 3)
      throw new Error(JSON.stringify(result));
    expect(result.document.gates[0]!.where).toEqual([
      { path: ["input", "amount"], op: "range", min: 1000, max: null },
    ]);
    const small = await hook(
      refund({ amount: 500, currency: "usd", environment: "staging" }),
      { text },
    );
    expect(small.permissionDecision).toBe("allow");
    const big = await hook(
      refund({ amount: 1500, currency: "usd", environment: "staging" }),
      { text },
    );
    expect(big.permissionDecision).toBe("deny");
    expect(big.permissionDecisionReason).toContain(
      "Gate big-refunds-after-review needs reviewer with ship",
    );
  });
});

test("a rule document checked against a hand-written where without values fails closed", async () => {
  const { simulate } = await import("../src/simulator");
  const compiled = compilePolicies([{ name: "r.yaml", text: RULES }]);
  if (!compiled.ok) throw new Error("no");
  const descriptor = {
    agentId: "a",
    installationId: "i",
    toolKey: "stripe",
    operationKey: "refund",
    resourceKind: "mcp_tool",
    resourceId: "stripe.refund",
    params: {},
  };
  // Without validated values: the allow with where never matches; the deny
  // on production and the one on large amounts still do.
  expect(
    simulate({ document: compiled.document, descriptor, now: new Date() })
      .outcome,
  ).toBe("deny");
  // With them, exactly as written.
  expect(
    simulate({
      document: compiled.document,
      descriptor,
      now: new Date(),
      values: {
        input: { amount: 10, currency: "usd", environment: "staging" },
      },
    }).outcome,
  ).toBe("allow");
});

describe("a mediated connection call in the run ledger", () => {
  const check = (
    state: string,
    surface = "S03",
    name = "input:stripe.refund",
  ) => ({
    surface,
    name,
    shape: "refund-args",
    contract: `sha256:${"a".repeat(64)}`,
    projection: `sha256:${"b".repeat(64)}`,
    state,
    at: "local",
    issues: state === "valid" ? [] : [{ path: "(value)", code: "size" }],
    reason: state === "unsupported" ? "not-json" : null,
    values: state === "valid" ? { amount: 10 } : null,
  });
  const call = (overrides: object = {}) => ({
    type: "connection.call",
    step: null,
    agent: "main",
    at: "2026-11-21T10:00:00Z",
    call: {
      type: "connection.call",
      event: "0b6f3c8e-6a3f-4a52-9c1e-2f7d7a1b9c10",
      connection: "stripe",
      operation: "refund",
      occurred_at: "2026-11-21T10:00:00Z",
      producer: { class: "runtime-observed", id: "connector:stripe" },
      input: check("valid"),
      execution: "succeeded",
      result: check("unsupported", "S04", "output:stripe.refund"),
      delivered: false,
      ...overrides,
    },
  });

  test("is a run event: execution and result validity kept apart", async () => {
    const { runEvent } = await import("../src/runs");
    expect(runEvent.safeParse(call()).success).toBe(true);
    // An invalid input never reaches the provider.
    const invalid = check("invalid");
    expect(
      runEvent.safeParse(call({ input: invalid, execution: "succeeded" }))
        .success,
    ).toBe(false);
    expect(
      runEvent.safeParse(call({ input: invalid, execution: "not-called" }))
        .success,
    ).toBe(true);
    // Only a valid check carries values, and only projected ones.
    const leaked = {
      ...check("invalid", "S04", "output:stripe.refund"),
      values: { a: 1 },
    };
    expect(runEvent.safeParse(call({ result: leaked })).success).toBe(false);
  });
});

describe("rendering briefs, inputs and where back to rule files", () => {
  // A receipt, fenced and header briefs, an input, `where` on rules and on
  // a gate: exporting must compile back to the very same document.
  const RECEIPT = CONTRACTS.replace(
    "    agents:\n",
    "      reviewer-result:\n        properties:\n          verdict: { values: [ship, fix-first], role: verdict }\n    receipts:\n      reviewer: { shape: reviewer-result }\n    agents:\n",
  );
  const FULL = `${RULES.replace(CONTRACTS, RECEIPT)}- gate: Big refunds after review
  tool: stripe
  operation: refund
  resource: { kind: mcp_tool, match: any }
  where: { input.amount: { min: 1000 }, input.currency: { in: [usd] } }
  requires: [{ agent: reviewer, verdict: ship }]
  otherwise: deny
`;

  test("compile, render, compile gives the same document", () => {
    const first = compilePolicies([{ name: "r.yaml", text: FULL }]);
    if (!first.ok || first.document.version !== 3)
      throw new Error(JSON.stringify(first));
    expect(Object.keys(first.document.briefs ?? {})).toEqual(["dev", "lease"]);
    expect(Object.keys(first.document.inputs ?? {})).toEqual(["stripe.refund"]);
    const rendered = renderPolicies(first.document);
    expect(rendered).toContain("brief:");
    expect(rendered).toContain("input.amount:");
    const again = compilePolicies([{ name: "b.yaml", text: rendered }]);
    if (!again.ok) throw new Error(JSON.stringify(again.issues));
    expect(again.document).toEqual(first.document);
  });

  test("a brief shape named like a receipt gets its own name", () => {
    // The receipt `reviewer` renders its shape as `reviewer`; a brief shape
    // also called `reviewer`, with other properties, must not merge with it.
    const clash = FULL.replace(
      "          shape: work-brief\n",
      "          shape: reviewer\n",
    ).replace(
      "      work-brief:\n",
      "      reviewer:\n        properties:\n          issue: { type: string, max: 40 }\n      work-brief:\n",
    );
    const first = compilePolicies([{ name: "r.yaml", text: clash }]);
    if (!first.ok || first.document.version !== 3)
      throw new Error(JSON.stringify(first));
    const again = compilePolicies([
      { name: "b.yaml", text: renderPolicies(first.document) },
    ]);
    if (!again.ok) throw new Error(JSON.stringify(again.issues));
    expect(again.document).toEqual(first.document);
  });
});
