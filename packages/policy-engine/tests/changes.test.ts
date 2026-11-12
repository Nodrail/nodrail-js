// What a run counts as a change, and rules written for an earlier engine.
import { describe, expect, test } from "vitest";
import { describeToolCall } from "../src/actions";
import { isChange, legacySubagentRuleProblem } from "../src/index";
import { compilePolicies } from "../src/yaml";

const described = (name: string, input: Record<string, unknown>) => {
  const action = describeToolCall(name, input, "/work");
  if (!action) throw new Error(`${name} could not be described`);
  return action;
};

describe("isChange", () => {
  test.each([
    ["Write", { file_path: "a.ts", content: "x" }],
    ["Edit", { file_path: "a.ts", old_string: "x", new_string: "y" }],
    ["MultiEdit", { file_path: "a.ts", edits: [] }],
    ["NotebookEdit", { notebook_path: "a.ipynb", new_source: "x" }],
    ["apply_patch", { command: "*** Delete File: a.ts\n" }],
    ["Bash", { command: "git commit -m x" }],
    ["Bash", { command: "pnpm test" }],
    ["Bash", { command: "git status && rm x" }],
    ["Bash", { command: "git branch -D old" }],
    ["PowerShell", { command: "Remove-Item x" }],
  ])("%s %j is a change", (name, input) => {
    expect(isChange(described(name, input))).toBe(true);
  });

  test.each([
    ["Bash", { command: "git status" }],
    ["Bash", { command: "git log -5" }],
    ["Bash", { command: "ls -la" }],
    ["Bash", { command: "pwd" }],
    ["Bash", { command: "git diff" }],
    ["Read", { file_path: "a.ts" }],
    ["Grep", { pattern: "x" }],
    ["Agent", { subagent_type: "reviewer" }],
    ["Task", { subagent_type: "reviewer" }],
    ["WebFetch", { url: "https://example.com" }],
    ["TodoWrite", { todos: [] }],
  ])("%s %j is not a change", (name, input) => {
    expect(isChange(described(name, input))).toBe(false);
  });

  test("the look-around commands are the read-only pack's", () => {
    expect(
      isChange({
        tool: "shell",
        operation: "command.run",
        resource: { kind: "command", id: "git logger" },
      }),
    ).toBe(true);
  });
});

describe("rules for starting a subagent written before engine level 3", () => {
  const legacy = `
- rule: Start subagents
  tool: claude-code
  operation: agent
  resource: { kind: tool, match: exact, value: Agent }
  effect: allow
`;

  test("are a compile error that says how to upgrade", () => {
    const result = compilePolicies([{ name: "old.yaml", text: legacy }]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toEqual([
      expect.objectContaining({
        file: "old.yaml",
        line: 5,
        column: 13,
        message: expect.stringContaining(
          "docs/runs.md#upgrading-rules-for-subagents",
        ) as string,
      }),
    ]);
  });

  test("whatever the value, and in a gate too", () => {
    const gate = `
- gate: Hold subagents
  tool: claude-code
  operation: agent
  resource: { kind: tool, match: any }
  requires: [{ agent: qa, verdict: pass }]
  otherwise: deny
`;
    const result = compilePolicies([{ name: "gate.yaml", text: gate }]);
    expect(!result.ok && result.issues[0]?.message).toMatch(
      /^Gate "Hold subagents": Starting a subagent is resource kind agent/,
    );
  });

  test("the same check is there for a rule form", () => {
    expect(
      legacySubagentRuleProblem({
        toolKey: "claude-code",
        operationKey: "agent",
        resourceKind: "tool",
      }),
    ).toContain("kind agent");
    expect(
      legacySubagentRuleProblem({
        toolKey: "claude-code",
        operationKey: "agent",
        resourceKind: "agent",
      }),
    ).toBeNull();
  });
});
