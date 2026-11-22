// Receipts on the Cloud hook: the header bridge's block is sent as written,
// and a SubagentHandback (Claude Code `auto` mode) finishes its step, with a
// refused receipt denied so the subagent resends.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runHook } from "../src/hooks";
import { fakeNodrail } from "./support/fake-nodrail";

const env = {
  NODRAIL_URL: "https://x",
  NODRAIL_CREDENTIAL: "c",
  NODRAIL_LEDGER: mkdtempSync(join(tmpdir(), "nodrail-hook-ledger-")),
};
const cwd = mkdtempSync(join(tmpdir(), "nodrail-hook-run-"));
const step = { agent_id: "a1", agent_type: "qa" };
const HEADER = "**RECEIPT qa**\nresult: PASS\nissue: ENG-1\n";

/** The fake server, with what /steps answers replaced. */
function server(steps: unknown = { recorded: true }) {
  const fake = fakeNodrail();
  const fetch = (async (input: string, init: RequestInit) => {
    if (String(input).endsWith("/steps")) {
      await fake.fetch(input, init);
      return new Response(JSON.stringify(steps), { status: 200 });
    }
    return fake.fetch(input, init);
  }) as typeof globalThis.fetch;
  return { ...fake, fetch };
}

const handback = (message: string) =>
  JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_name: "SubagentHandback",
    tool_input: { message },
    tool_use_id: "toolu_9",
    cwd,
    session_id: "s1",
    ...step,
  });

describe("receipts on the Cloud hook", () => {
  test("a stop ending with a header block sends that block", async () => {
    const fake = server();
    await runHook(
      JSON.stringify({
        hook_event_name: "SubagentStop",
        cwd,
        session_id: "s1",
        ...step,
        last_assistant_message: `Checked.\n\n${HEADER}`,
      }),
      env,
      { fetch: fake.fetch },
    );
    expect(fake.requests[0]?.body).toMatchObject({
      event: "finished",
      receipt: { text: HEADER.trimEnd() },
    });
  });

  test("a title joined to the agent (RECEIPT-qa) is sent too", async () => {
    const fake = server();
    const joined = "RECEIPT-qa\nresult: PASS\nissue: ENG-1";
    await runHook(
      JSON.stringify({
        hook_event_name: "SubagentStop",
        cwd,
        session_id: "s1",
        ...step,
        last_assistant_message: `Checked.\n\n${joined}\n`,
      }),
      env,
      { fetch: fake.fetch },
    );
    expect(fake.requests[0]?.body).toMatchObject({
      event: "finished",
      receipt: { text: joined },
    });
  });

  test("a hand-back finishes the step, then is decided like any call", async () => {
    const fake = server();
    const result = await runHook(handback(`Done.\n\n${HEADER}`), env, {
      fetch: fake.fetch,
    });
    expect(result.stdout).toBe("");
    expect(fake.requests.map((r) => r.path)).toEqual([
      "/steps",
      "/actions",
      expect.stringContaining("/actions/"),
    ]);
    expect(fake.requests[0]?.body).toMatchObject({
      step: { id: "a1", agent: "qa" },
      event: "finished",
      receipt: { text: HEADER.trimEnd() },
    });
  });

  test("a receipt Cloud refuses denies the hand-back with its reason", async () => {
    const fake = server({
      recorded: false,
      receipt: { state: "invalid", reason: "issue: required" },
    });
    const result = await runHook(handback("RECEIPT qa\nresult: PASS\n"), env, {
      fetch: fake.fetch,
    });
    expect(JSON.parse(result.stdout)).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: "deny",
        permissionDecisionReason: expect.stringContaining(
          "your receipt can't be accepted: issue: required",
        ),
      },
    });
    expect(fake.requests.map((r) => r.path)).toEqual(["/steps"]);
  });
});
