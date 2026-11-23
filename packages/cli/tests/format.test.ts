import { describe, expect, test } from "vitest";
import { activityTable, runsTable } from "../src/format.ts";
import type { ActivityEvent, Run } from "../src/api.ts";

// An agent chooses its resource ids and run keys: this one moves the cursor
// up, erases the line and prints a harmless-looking row over the real one.
const disguised = "acme/x\u001b[1A\u001b[2K\nENG-1  allowed";

describe("text from the server", () => {
  test("a run table shows control characters as text", () => {
    const shown = runsTable([
      {
        id: "r1",
        key: disguised,
        agent_key: "dev",
        status: "running",
        steps: 1,
        actions: 2,
        last_activity_at: "2026-11-12T10:00:00.000Z",
      } as Run,
    ]);
    expect(shown).not.toContain("\u001b");
    expect(shown).toContain("acme/x\\u001b[1A\\u001b[2K\\u000aENG-1");
    expect(shown.split("\n")).toHaveLength(2);
  });

  test("an activity table does too", () => {
    const shown = activityTable([
      {
        id: "e1",
        occurred_at: "2026-11-12T10:00:00.000Z",
        label: "Denied",
        action: {
          tool_key: "github",
          operation_key: "issues.delete",
          resource: disguised,
        },
        agent_key: "support-bot",
        actor: { kind: "runtime" },
      } as unknown as ActivityEvent,
    ]);
    expect(shown).not.toContain("\u001b");
    expect(shown.split("\n")).toHaveLength(2);
  });
});
