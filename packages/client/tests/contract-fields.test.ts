// What Cloud receives of a declared brief or input: the started agent's
// brief as its reporting projection in `params.brief`, and an operation's
// input with classified fields as `[classified]`, checked where the value is
// seen. Cloud reads `where` only from these (R317), so without them an allow
// with `where brief.*` never matches there.
import { compilePolicies } from "@nodrail/policy-engine/yaml";
import { describe, expect, test } from "vitest";
import {
  createNodrail,
  withContractFields,
  type CallContracts,
} from "../src/index";
import { describeToolCall } from "../src/hooks";
import { fakeNodrail } from "./support/fake-nodrail";

const RULES = `- required_engine_version: 4
- contracts:
    shapes:
      refund-args:
        properties:
          amount: { type: integer, min: 1, unit: usd_cents, report: true }
          card_token: { type: string, max: 64, classification: secret }
          note: { type: string, max: 200, optional: true }
      work-brief:
        properties:
          issue: { type: string, max: 40, report: true }
          budget: { type: integer, min: 1, max: 500, report: true }
          customer: { type: string, max: 80, classification: pii }
          notes: { type: string, max: 400 }
    agents:
      dev: { brief: work-brief }
    connections:
      stripe:
        operations:
          refund: { input: refund-args }
      lookup:
        operations:
          call: { input: refund-args }
- rule: Start agents
  tool: claude-code
  operation: agent
  resource: { kind: agent, match: any }
  effect: allow
`;

function contracts(): CallContracts {
  const compiled = compilePolicies([{ name: "rules.yaml", text: RULES }]);
  if (!compiled.ok || compiled.document.version !== 3)
    throw new Error(JSON.stringify(compiled.ok ? {} : compiled.issues));
  return {
    briefs: compiled.document.briefs,
    inputs: compiled.document.inputs,
  };
}

const BRIEF = [
  "Fix the refund bug.",
  "",
  "```nodrail-brief",
  "issue: ENG-7",
  "budget: 40",
  "customer: Ada Lovelace",
  "notes: private context",
  "```",
].join("\n");

const dispatch = (prompt: string) => ({
  subagent_type: "dev",
  description: "work",
  prompt,
});

describe("withContractFields", () => {
  test("a dispatch carries its brief's reported fields only", () => {
    const input = dispatch(BRIEF);
    const action = describeToolCall("Agent", input)!;
    const fields = withContractFields(action, input, contracts());
    if ("refusal" in fields) throw new Error(fields.refusal);
    // Only report: true fields; pii and unreported ones never.
    expect(fields.action.params.brief).toEqual({ issue: "ENG-7", budget: 40 });
    expect(JSON.stringify(fields.action)).not.toContain("Ada Lovelace");
  });

  test("a brief that doesn't follow its contract is refused before it is sent", () => {
    const input = dispatch("```nodrail-brief\nissue: ENG-7\n```");
    const action = describeToolCall("Agent", input)!;
    const fields = withContractFields(action, input, contracts());
    expect(fields).toHaveProperty("refusal");
    expect((fields as { refusal: string }).refusal).toContain("budget");
  });

  test("an operation's classified arguments go as [classified]", () => {
    const input = { amount: 1200, card_token: "tok_live_secret" };
    const action = describeToolCall("mcp__stripe__refund", input)!;
    const fields = withContractFields(action, input, contracts());
    if ("refusal" in fields) throw new Error(fields.refusal);
    expect(fields.action.params.input).toEqual({
      amount: 1200,
      card_token: "[classified]",
    });
    expect(JSON.stringify(fields.action)).not.toContain("tok_live_secret");
  });

  test("an invalid input is refused and never sent", () => {
    const input = { amount: 0, card_token: "tok" };
    const action = describeToolCall("mcp__stripe__refund", input)!;
    expect(withContractFields(action, input, contracts())).toHaveProperty(
      "refusal",
    );
  });

  test("without contracts the action is unchanged", () => {
    const input = dispatch(BRIEF);
    const action = describeToolCall("Agent", input)!;
    expect(withContractFields(action, input, null)).toEqual({ action });
    expect(withContractFields(action, input, {})).toEqual({ action });
  });
});

describe("through the SDK", () => {
  test("a guarded tool's classified arguments reach Cloud as [classified]", async () => {
    const server = fakeNodrail();
    const nodrail = createNodrail({
      url: "https://nodrail.test",
      credential: "c",
      fetch: server.fetch,
      env: {},
      subject: null,
      contracts: contracts(),
    });
    const lookup = nodrail.guard(
      async function lookup(_args: { amount: number; card_token: string }) {
        return "ok";
      },
      { onBlocked: "throw" },
    );
    await expect(lookup({ amount: 5, card_token: "tok_secret" })).resolves.toBe(
      "ok",
    );
    expect(server.seen()[0]?.params.input).toEqual({
      amount: 5,
      card_token: "[classified]",
    });
    await expect(lookup({ amount: -1, card_token: "x" })).rejects.toThrow(
      /contract/,
    );
    expect(server.seen()).toHaveLength(1);
  });
});
