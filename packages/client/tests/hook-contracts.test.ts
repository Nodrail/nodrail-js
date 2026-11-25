// The Cloud hook and `.nodrail/contracts.json`: the brief's reported
// fields in `params.brief` and classified inputs as `[classified]`, checked
// by the SDK's own `withContractFields`, loaded only for a call a contract
// covers. Without the file nothing changes; a file or checker that can't be
// read blocks the calls it might cover.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compilePolicies } from "@nodrail/policy-engine/yaml";
import { describe, expect, test } from "vitest";
import {
  CONTRACTS_FILE,
  findContractsFile,
  hookContractFields,
} from "../src/hook-contracts";
import { describeToolCall, runHook } from "../src/hooks";
import { fakeNodrail } from "./support/fake-nodrail";

const RULES = `- required_engine_version: 4
- contracts:
    shapes:
      refund-args:
        properties:
          amount: { type: integer, min: 1, unit: usd_cents, report: true }
          card_token: { type: string, max: 64, classification: secret }
      work-brief:
        properties:
          issue: { type: string, max: 40, report: true }
          budget: { type: integer, min: 1, max: 500, report: true }
          customer: { type: string, max: 80, classification: pii }
    agents:
      dev: { brief: work-brief }
    connections:
      stripe:
        operations:
          refund: { input: refund-args }
- rule: Start agents
  tool: claude-code
  operation: agent
  resource: { kind: agent, match: any }
  effect: allow
`;

/** `.nodrail/contracts.json` as `nodrail apply` writes it. */
function contractsJson() {
  const compiled = compilePolicies([{ name: "rules.yaml", text: RULES }]);
  if (!compiled.ok || compiled.document.version !== 3)
    throw new Error("expected a version 3 document");
  const { briefs, inputs } = compiled.document;
  return `${JSON.stringify({ version: 1, briefs, inputs }, null, 2)}\n`;
}

function project(text: string | null = contractsJson()) {
  const root = mkdtempSync(join(tmpdir(), "nodrail-hook-contracts-"));
  if (text !== null) {
    mkdirSync(join(root, ".nodrail"));
    writeFileSync(join(root, CONTRACTS_FILE), text);
  }
  const below = join(root, "src", "deep");
  mkdirSync(below, { recursive: true });
  return { root, below };
}

const env = (extra: Record<string, string> = {}) => ({
  NODRAIL_URL: "https://x",
  NODRAIL_CREDENTIAL: "c",
  NODRAIL_LEDGER: mkdtempSync(join(tmpdir(), "nodrail-hook-ledger-")),
  ...extra,
});

const BRIEF = [
  "Fix the refund bug.",
  "",
  "```nodrail-brief",
  "issue: ENG-7",
  "budget: 40",
  "customer: Ada Lovelace",
  "```",
].join("\n");

const dispatch = (cwd: string, prompt: string) =>
  JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_name: "Agent",
    tool_input: { subagent_type: "dev", description: "work", prompt },
    tool_use_id: "toolu_1",
    cwd,
  });

const decision = (stdout: string) =>
  stdout
    ? (
        JSON.parse(stdout) as {
          hookSpecificOutput: {
            permissionDecision: string;
            permissionDecisionReason: string;
          };
        }
      ).hookSpecificOutput
    : { permissionDecision: "allow", permissionDecisionReason: "" };

describe("the Cloud hook sends what Cloud's where reads", () => {
  test("a dispatch carries only its brief's reported fields, from the nearest contracts file", async () => {
    const { below } = project();
    const server = fakeNodrail();
    const result = await runHook(dispatch(below, BRIEF), env(), {
      fetch: server.fetch,
    });
    expect(decision(result.stdout).permissionDecision).toBe("allow");
    const [sent] = server.seen();
    expect(sent!.params.brief).toEqual({ issue: "ENG-7", budget: 40 });
    expect(JSON.stringify(server.requests)).not.toContain("Ada Lovelace");
  });

  test("CLAUDE_PROJECT_DIR names the project folder", async () => {
    const { root } = project();
    const elsewhere = project(null).below;
    const server = fakeNodrail();
    await runHook(
      dispatch(elsewhere, BRIEF),
      env({ CLAUDE_PROJECT_DIR: root }),
      { fetch: server.fetch },
    );
    expect(server.seen()[0]!.params.brief).toEqual({
      issue: "ENG-7",
      budget: 40,
    });
  });

  test("a brief that doesn't follow its contract is refused before Cloud is asked", async () => {
    const { root } = project();
    const server = fakeNodrail();
    const result = await runHook(
      dispatch(root, "```nodrail-brief\nissue: ENG-7\n```"),
      env(),
      { fetch: server.fetch },
    );
    expect(decision(result.stdout)).toMatchObject({
      permissionDecision: "deny",
      permissionDecisionReason: expect.stringContaining("budget") as string,
    });
    expect(server.requests.filter((r) => r.path === "/actions")).toEqual([]);
  });

  test("an operation's classified arguments go as [classified]", async () => {
    const { root } = project();
    const server = fakeNodrail();
    await runHook(
      JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "mcp__stripe__refund",
        tool_input: { amount: 1200, card_token: "tok_live_secret" },
        tool_use_id: "toolu_2",
        cwd: root,
      }),
      env(),
      { fetch: server.fetch },
    );
    expect(server.seen()[0]!.params.input).toEqual({
      amount: 1200,
      card_token: "[classified]",
    });
    expect(JSON.stringify(server.requests)).not.toContain("tok_live_secret");
  });

  test("without a contracts file the action is sent as before", async () => {
    const { root } = project(null);
    const server = fakeNodrail();
    await runHook(dispatch(root, BRIEF), env(), {
      fetch: server.fetch,
    });
    expect(server.seen()[0]!.params.brief).toBeUndefined();
  });
});

describe("fail closed", () => {
  const action = describeToolCall("Agent", {
    subagent_type: "dev",
    prompt: BRIEF,
  })!;
  const input = { subagent_type: "dev", prompt: BRIEF };

  test.each([
    ["not JSON", "{"],
    ["another version", JSON.stringify({ version: 2 })],
    ["briefs not an object", JSON.stringify({ version: 1, briefs: [] })],
    ["inputs not an object", JSON.stringify({ version: 1, inputs: [] })],
    ["null record", "null"],
    ["oversized file", " ".repeat(1024 * 1024 + 1)],
  ])("an unreadable file (%s) blocks", async (_label, text) => {
    const { root } = project(text);
    const fields = await hookContractFields(action, input, {
      cwd: root,
      env: {},
    });
    expect(fields).toEqual({
      refusal: expect.stringContaining(
        `${CONTRACTS_FILE} can't be read`,
      ) as string,
    });
  });

  test("a valid empty contracts file leaves an action unchanged", async () => {
    const { root } = project('{"version":1}');
    expect(
      await hookContractFields(action, input, { cwd: root, env: {} }),
    ).toEqual({ action });
  });

  test("a covered call whose checker can't load blocks; an uncovered one never loads it", async () => {
    const { root } = project();
    const broken = () => Promise.reject(new Error("missing chunk"));
    expect(
      await hookContractFields(action, input, { cwd: root, env: {} }, broken),
    ).toEqual({
      refusal: expect.stringContaining("couldn't load its checker") as string,
    });
    const other = describeToolCall("Bash", { command: "git status" })!;
    expect(
      await hookContractFields(
        other,
        { command: "git status" },
        { cwd: root, env: {} },
        broken,
      ),
    ).toEqual({ action: other });
  });

  test("CLAUDE_PROJECT_DIR without a contracts file finds none", () => {
    const { root } = project(null);
    expect(findContractsFile(root, { CLAUDE_PROJECT_DIR: root })).toBeNull();
    expect(findContractsFile("/", {})).toBeNull();
  });
});
