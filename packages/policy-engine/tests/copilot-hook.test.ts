// GitHub Copilot CLI's hook (W5): each call is read as the Claude Code call
// it is, judged by the same rules and guards, and answered in Copilot's
// shape. Event and answer shapes as verified live with Copilot CLI 1.0.114.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  claudeAnswerFor,
  copilotAnswer,
  copilotEvents,
  copilotRefusal,
  patchFiles,
} from "../src/copilot-hook.ts";
import { cli } from "./run-cli.ts";

const cwd = "/work/desk";
const call = (toolName: string, toolArgs: unknown) =>
  JSON.stringify({
    sessionId: "s1",
    cwd,
    toolCallId: "c1",
    toolName,
    toolArgs,
  });

const translated = (
  toolName: string,
  toolArgs: unknown,
  servers?: string[],
) => {
  const events = copilotEvents(call(toolName, toolArgs), servers);
  if (typeof events === "string") throw new Error(events);
  return events.map((event) => {
    const { tool_name, tool_input } = JSON.parse(event) as {
      tool_name: string;
      tool_input: unknown;
    };
    return [tool_name, tool_input];
  });
};

describe("Copilot's calls as Claude Code's", () => {
  test.each([
    [
      "bash",
      { command: "ls", description: "list" },
      ["Bash", { command: "ls" }],
    ],
    [
      "view",
      { path: "/work/desk/a.md" },
      ["Read", { file_path: "/work/desk/a.md" }],
    ],
    [
      "create",
      { path: "b.md", file_text: "x" },
      ["Write", { file_path: "b.md", content: "x" }],
    ],
    [
      "edit",
      { path: "b.md", old_str: "x", new_str: "y" },
      ["Edit", { file_path: "b.md", old_string: "x", new_string: "y" }],
    ],
    [
      "rg",
      { pattern: "hello", paths: "." },
      ["Grep", { pattern: "hello", path: "." }],
    ],
    ["glob", { pattern: "*.txt" }, ["Glob", { pattern: "*.txt", path: "." }]],
    [
      "web_fetch",
      { url: "https://example.com" },
      ["WebFetch", { url: "https://example.com", prompt: "" }],
    ],
    [
      "task",
      { description: "d", prompt: "p" },
      [
        "Task",
        { subagent_type: "general-purpose", description: "d", prompt: "p" },
      ],
    ],
  ])("%s", (name, args, expected) => {
    expect(translated(name, args)).toEqual([expected]);
  });

  test("a patch is one call per file it names, relative paths from cwd", () => {
    const patch =
      "*** Begin Patch\n*** Add File: made.txt\n+one\n*** Update File: /etc/hosts\n@@\n-a\n+b\n*** Delete File: old.txt\n*** End Patch\n";
    expect(patchFiles(patch).map((file) => file.path)).toEqual([
      "made.txt",
      "/etc/hosts",
      "old.txt",
    ]);
    expect(
      translated("apply_patch", patch).map(([name, input]) => [
        name,
        (input as { file_path: string }).file_path,
      ]),
    ).toEqual([
      ["Write", join(cwd, "made.txt")],
      ["Edit", "/etc/hosts"],
      ["Edit", join(cwd, "old.txt")],
    ]);
    expect(copilotEvents(call("apply_patch", "no headers"))).toContain(
      "names no file",
    );
  });

  test("MCP tools by the setup's server names, the longest first", () => {
    expect(
      translated("support-memory-search_nodes", {}, [
        "support",
        "support-memory",
      ]),
    ).toEqual([["mcp__support-memory__search_nodes", {}]]);
    // Not a server nodrail declares: judged as the tool it says it is.
    expect(translated("other-thing", { a: 1 })).toEqual([
      ["other-thing", { a: 1 }],
    ]);
  });

  test("a call that can't be read is refused", () => {
    expect(copilotEvents("not json")).toContain("could not be read");
    expect(copilotEvents(JSON.stringify({ toolArgs: {} }))).toContain(
      "could not be identified",
    );
  });
});

describe("nodrail-policy hook --host copilot", () => {
  const folder = mkdtempSync(join(tmpdir(), "nodrail-copilot-"));
  const rules = join(folder, "rules.yaml");
  writeFileSync(
    rules,
    "- rule: Status\n  command: { prefix: git status }\n  effect: allow\n",
  );
  const hook = (event: string, ...flags: string[]) =>
    cli(["hook", rules, "--host", "copilot", ...flags], event);
  const answer = (stdout: string) =>
    JSON.parse(stdout) as {
      permissionDecision: string;
      permissionDecisionReason: string;
    };

  test("allowed: silence; not covered: Copilot's deny, with the reason", async () => {
    expect(await hook(call("bash", { command: "git status" }))).toEqual({
      code: 0,
      stdout: "",
      stderr: "",
    });
    const denied = await hook(call("bash", { command: "git push" }));
    expect(denied.code).toBe(0);
    expect(answer(denied.stdout)).toEqual({
      permissionDecision: "deny",
      permissionDecisionReason: expect.stringContaining("no rule covers"),
    });
  });

  test("a review can't be asked from Copilot's hook: it is a deny", async () => {
    const reviewed = await hook(
      call("bash", { command: "git push" }),
      "--unmatched",
      "ask",
    );
    expect(answer(reviewed.stdout)).toMatchObject({
      permissionDecision: "deny",
      permissionDecisionReason: expect.stringContaining("can't ask a person"),
    });
  });

  test("a patch that touches the rules is refused, whatever else it changes", async () => {
    const patch = `*** Begin Patch\n*** Add File: notes.txt\n+x\n*** Update File: ${rules}\n@@\n-a\n+b\n*** End Patch\n`;
    const refused = await hook(call("apply_patch", patch));
    expect(answer(refused.stdout).permissionDecision).toBe("deny");
  });

  test("an unreadable call is refused in Copilot's shape", async () => {
    expect(answer((await hook("nope")).stdout).permissionDecision).toBe("deny");
  });
});

describe("Claude Code's hook, run by Copilot", () => {
  const folder = mkdtempSync(join(tmpdir(), "nodrail-copilot-claude-"));
  const rules = join(folder, "rules.yaml");
  writeFileSync(
    rules,
    "- rule: Status\n  command: { prefix: git status }\n  effect: allow\n",
  );
  // Copilot's shape for Claude Code's hooks: Claude's names, its own arguments.
  const claudeEvent = (tool_name: string, tool_input: unknown) =>
    JSON.stringify({
      hook_event_name: "PreToolUse",
      session_id: "s1",
      cwd: folder,
      tool_use_id: "c1",
      tool_name,
      tool_input,
    });
  const underCopilot = async (event: string, ...flags: string[]) => {
    process.env.COPILOT_HOOK_DEPTH = "1";
    try {
      return await cli(["hook", rules, ...flags], event);
    } finally {
      delete process.env.COPILOT_HOOK_DEPTH;
    }
  };
  const decision = (stdout: string) =>
    (
      JSON.parse(stdout) as {
        hookSpecificOutput: { permissionDecision: string };
      }
    ).hookSpecificOutput.permissionDecision;

  test("reads Copilot's arguments, answers in Claude Code's shape", async () => {
    expect(
      (await underCopilot(claudeEvent("Bash", { command: "git status" })))
        .stdout,
    ).toBe("");
    // `path`, not `file_path`: the rules file, which no file tool may change.
    const edit = await underCopilot(
      claudeEvent("Edit", { path: rules, old_str: "a", new_str: "b" }),
    );
    expect(decision(edit.stdout)).toBe("deny");
  });

  test("a review is a deny: Copilot can't ask", async () => {
    const asked = await underCopilot(
      claudeEvent("Bash", { command: "git push" }),
      "--unmatched",
      "ask",
    );
    expect(decision(asked.stdout)).toBe("deny");
  });
});

describe("Copilot's less common calls and answers", () => {
  test.each([
    ["update_todo", { todos: [{ title: "x" }] }, "TodoWrite"],
    ["update_todo", {}, "TodoWrite"],
    ["ask_user", { question: "ok?" }, "AskUserQuestion"],
    ["ask_user", {}, "AskUserQuestion"],
    ["grep", { pattern: "a" }, "Grep"],
  ])("%s is %s", (name, args, expected) => {
    expect(translated(name, args)[0]![0]).toBe(expected);
  });

  test("arguments as JSON text, plain text, or nothing", () => {
    expect(translated("bash", JSON.stringify({ command: "ls" }))).toEqual([
      ["Bash", { command: "ls" }],
    ]);
    expect(translated("other", "plain text")).toEqual([
      ["other", { input: "plain text" }],
    ]);
    expect(translated("other", "42")).toEqual([["other", { input: "42" }]]);
    expect(copilotEvents(call("bash", null))).toContain(
      "could not be identified",
    );
    expect(
      translated("apply_patch", { patch: "*** Add File: a.txt\n+x\n" }),
    ).toEqual([["Write", { file_path: join(cwd, "a.txt"), content: "" }]]);
  });

  const result = (stdout: string, exitCode = 0, stderr = "") => ({
    stdout,
    stderr,
    exitCode,
  });
  const claude = (decision: string, reason?: string) =>
    JSON.stringify({
      hookSpecificOutput: {
        permissionDecision: decision,
        ...(reason ? { permissionDecisionReason: reason } : {}),
      },
    });
  const reasonOf = (answer: { stdout: string }) =>
    answer.stdout
      ? (JSON.parse(answer.stdout) as { permissionDecisionReason: string })
          .permissionDecisionReason
      : null;

  test("each kind of hook answer, as Copilot reads it", () => {
    expect(reasonOf(copilotAnswer([result("")]))).toBeNull();
    expect(reasonOf(copilotAnswer([result(claude("allow"))]))).toBeNull();
    expect(reasonOf(copilotAnswer([result(claude("ask", "review"))]))).toBe(
      "review",
    );
    expect(reasonOf(copilotAnswer([result(claude("deny"))]))).toBe(
      "Nodrail blocked this call.",
    );
    expect(reasonOf(copilotAnswer([result("", 2, " no rules \n")]))).toBe(
      "no rules",
    );
    expect(reasonOf(copilotAnswer([result("", 2)]))).toBe(
      "Nodrail blocked this call.",
    );
    expect(reasonOf(copilotAnswer([result("not json")]))).toContain(
      "could not be read",
    );
    // The first deny wins.
    expect(
      reasonOf(
        copilotAnswer([
          result(""),
          result(claude("deny", "first")),
          result(claude("deny", "second")),
        ]),
      ),
    ).toBe("first");
  });

  test("Claude Code's answer under Copilot: a deny, or nothing", () => {
    expect(claudeAnswerFor(result(""))).toEqual(result(""));
    const denied = claudeAnswerFor(copilotRefusal("no"));
    expect(JSON.parse(denied.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "no",
      },
    });
  });
});

describe("the hook's telemetry under Copilot", () => {
  test("an unreadable telemetry file is a warning, never a different decision", async () => {
    const folder = mkdtempSync(join(tmpdir(), "nodrail-copilot-telemetry-"));
    const rules = join(folder, "rules.yaml");
    writeFileSync(
      rules,
      "- rule: Status\n  command: { prefix: git status }\n  effect: allow\n",
    );
    const answer = await cli(
      [
        "hook",
        rules,
        "--host",
        "copilot",
        "--telemetry",
        join(folder, "missing.json"),
      ],
      call("bash", { command: "git status" }),
    );
    expect(answer.code).toBe(0);
    expect(answer.stdout).toBe("");
    expect(answer.stderr).toContain("telemetry is off");
  });
});
