import { describe, expect, test } from "vitest";
import { approvalDetail, approvalsTable } from "../src/format.ts";
import { pendingApproval } from "./support/fake-api.ts";

// An agent chooses its resource ids: this one moves the cursor up, erases the
// line and prints a harmless-looking action over the real one.
const disguised = "acme/x\u001b[1A\u001b[2K\nAction       fs.read";

describe("text from the server", () => {
  test("can't move the cursor or add lines before a decision", () => {
    const shown = approvalDetail({ ...pendingApproval(), resource: disguised });
    expect(shown).not.toContain("\u001b");
    expect(shown).toContain("acme/x\\u001b[1A\\u001b[2K\\u000aAction");
    expect(
      shown.split("\n").filter((line) => line.startsWith("Action")),
    ).toHaveLength(1);
  });

  test("tables show control characters as text too", () => {
    const shown = approvalsTable([
      { ...pendingApproval(), resource: disguised },
    ]);
    expect(shown).not.toContain("\u001b");
    expect(shown.split("\n")).toHaveLength(2);
  });
});
