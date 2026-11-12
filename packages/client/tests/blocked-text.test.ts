// What the agent, and the person reading its output, is told for each block.
import { describe, expect, test } from "vitest";
import { blockedText } from "../src/blocked-text.ts";

const blocked = (code: string, reference: string | null = "APR-1") =>
  blockedText({ allowed: false, code, reason: null, reference });

describe("each reason a call is blocked", () => {
  test.each([
    ["APPROVAL_PENDING", /waiting for a person.*APR-1/],
    ["UNKNOWN_PERMISSION_BLOCKED", /waiting for a person/],
    ["DENIED", /denied.*APR-1/],
    ["EXPIRED", /expired before anyone decided/],
    ["INVALIDATED", /something changed/],
    ["NOT_CONFIGURED", /NODRAIL_CREDENTIAL/],
    ["INSECURE_URL", /https/],
    ["UNAUTHENTICATED", /credential was refused/],
    ["QUOTA_EXCEEDED", /for the month/],
    ["RATE_LIMITED", /too many calls/],
    ["UNAVAILABLE", /could not confirm.*UNAVAILABLE/],
  ])("%s", (code, message) => {
    expect(blocked(code)).toMatch(message);
  });

  test("without a reference, none is mentioned", () => {
    expect(blocked("DENIED", null)).toBe("Nodrail: this action is denied.");
  });

  test("a gate says which steps to run, so the agent can run them", () => {
    const text = blockedText({
      allowed: false,
      code: "DENIED",
      reason: "gate",
      reference: "REQ-1",
    });
    expect(text).toMatch(
      /^Nodrail: this action is denied\. Request REQ-1\. A gate/,
    );
    expect(text).toMatch(/QA or review.*after the last change/);
  });

  test.each([
    ["budget", /budget .* is used up/],
    ["agent_paused", /agent is paused/],
    ["rule", /^Nodrail: this action is denied\. Request APR-1\.$/],
  ])("a %s reason", (reason, message) => {
    expect(
      blockedText({
        allowed: false,
        code: "DENIED",
        reason,
        reference: "APR-1",
      }),
    ).toMatch(message);
  });

  test("every message says the action is blocked or waiting", () => {
    for (const code of ["DENIED", "EXPIRED", "SOMETHING_NEW"])
      expect(blocked(code)).toMatch(/^Nodrail: /);
  });
});
