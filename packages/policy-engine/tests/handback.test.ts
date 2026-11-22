// Claude Code's SubagentHandback (permission mode `auto`) through
// `nodrail-policy hook`: a subagent delivering its final report. When no rule
// covers it, it goes ahead, so a policy that blocks what it doesn't cover
// (every starter pack) doesn't strand background subagents. A rule still
// decides it as written, and a receipt contract still refuses an invalid
// receipt before delivery.
import { describe, expect, test } from "vitest";
import { HANDBACK_ACTION } from "../src/hook-runs";
import { starterPacks } from "../src/packs";
import { cli } from "./run-cli.ts";
import { hookAnswer, scratchRepo } from "./support/hook-answers.ts";

const scratch = (rules: string) =>
  scratchRepo(rules, "nodrail-handback-", "feature/x");

const REPORT = "Done.\n\n```nodrail-receipt\nverdict: pass\n```\n";

async function handback(rules: string, message = REPORT) {
  const { repo, file } = scratch(rules);
  const sent = await cli(
    ["hook", file],
    JSON.stringify({
      session_id: "s-1",
      cwd: repo,
      transcript_path: "/dev/null",
      permission_mode: "auto",
      hook_event_name: "PreToolUse",
      tool_name: "SubagentHandback",
      tool_input: { message },
      tool_use_id: "toolu_1",
      agent_id: "a1",
      agent_type: "qa",
    }),
  );
  expect(sent.code).toBe(0);
  return hookAnswer(sent.stdout);
}

const RULE = (effect: string) => `
- rule: Hand-backs
  tool: ${HANDBACK_ACTION.tool}
  operation: ${HANDBACK_ACTION.operation}
  resource: { kind: tool, match: any }
  effect: ${effect}
`;

const GATED = `- required_engine_version: 3
- gate: G
  tool: claude-code
  operation: agent
  resource: { kind: agent, match: exact, value: github }
  requires: [{ agent: qa, verdict: pass }]
  otherwise: deny
`;

const CONTRACTS = `- required_engine_version: 4
- contracts:
    shapes:
      qa-result:
        properties:
          verdict: { values: [pass, fail], role: verdict }
    receipts:
      qa: { shape: qa-result }
`;

describe("a hand-back no rule covers", { timeout: 60_000 }, () => {
  test.each(Object.keys(starterPacks))(
    "goes ahead under the %s starter pack, which blocks what it doesn't cover",
    async (pack) => {
      const text = starterPacks[pack as keyof typeof starterPacks].text;
      expect((await handback(text)).permissionDecision).toBe("allow");
    },
  );

  test("goes ahead with a run ledger too (rules with gates)", async () => {
    expect((await handback(GATED)).permissionDecision).toBe("allow");
  });

  test("any other call no rule covers is still blocked", async () => {
    const { repo, file } = scratch(starterPacks["read-only"].text);
    const sent = await cli(
      ["hook", file],
      JSON.stringify({
        session_id: "s-1",
        cwd: repo,
        hook_event_name: "PreToolUse",
        tool_name: "SendMessage",
        tool_input: { to: "a1", message: "hi" },
      }),
    );
    expect(sent.stdout).toContain(
      "no rule covers claude-code sendmessage on SendMessage",
    );
  });
});

describe("a rule on hand-backs decides as written", { timeout: 60_000 }, () => {
  test("deny", async () => {
    const answer = await handback(
      starterPacks["read-only"].text + RULE("deny"),
    );
    expect(answer.permissionDecision).toBe("deny");
    expect(answer.permissionDecisionReason).toContain("rule");
  });

  test("a person reviews it", async () => {
    const answer = await handback(
      starterPacks["read-only"].text + RULE("require_approval"),
    );
    expect(answer.permissionDecision).toBe("ask");
  });
});

describe(
  "with a receipt contract and no hand-back rule",
  { timeout: 60_000 },
  () => {
    test("an invalid receipt is refused so the subagent resends", async () => {
      const answer = await handback(
        CONTRACTS,
        "Done.\n\n```nodrail-receipt\nverdict: maybe\n```\n",
      );
      expect(answer.permissionDecision).toBe("deny");
      expect(answer.permissionDecisionReason).toContain(
        "your receipt can't be accepted: verdict: expected one of pass, fail",
      );
    });

    test("a missing receipt is refused", async () => {
      const answer = await handback(CONTRACTS, "Done, no receipt.");
      expect(answer.permissionDecision).toBe("deny");
    });

    test("a valid receipt goes ahead", async () => {
      expect((await handback(CONTRACTS)).permissionDecision).toBe("allow");
    });
  },
);
