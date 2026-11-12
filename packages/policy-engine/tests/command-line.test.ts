// The nodrail-policy command line, run in-process so every path is measured.
// Separate-process runs are covered by the docs and package tests.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { cli } from "./run-cli.ts";

const folder = mkdtempSync(join(tmpdir(), "nodrail-cli-"));
const write = (name: string, text: string) => {
  const path = join(folder, name);
  writeFileSync(path, text);
  return path;
};

const rules = write(
  "rules.yaml",
  `- rule: Safe reads
  command: { prefix: git status }
  effect: allow

- rule: Refunds under 1000
  tool: stripe
  operation: refunds.create
  resource: { kind: invoice, match: any }
  condition:
    - { field: amount, op: lte, value: 1000 }
  effect: allow

- rule: Only this agent
  tool: github
  operation: issues.create
  resource: { kind: repository, match: any }
  agent: support
  effect: allow
`,
);
const broken = write("broken.yaml", "- rule: Nothing else\n");

describe("help and setup", () => {
  test("--help prints the usage", async () => {
    const result = await cli(["--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Usage: nodrail-policy");
  });

  test("--version prints the package's version", async () => {
    expect((await cli(["--version"])).stdout).toMatch(/^\d+\.\d+\.\d+\n$/);
  });

  test("init prints a starter pack", async () => {
    const result = await cli(["init", "repo-work"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("required_engine_version");
  });

  test("an unknown pack lists the real ones", async () => {
    const result = await cli(["init", "nope"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("read-only, repo-work");
  });

  test.each([[[]], [["validate"]], [["unknown", rules]]])(
    "%j prints the usage and exits 2",
    async (args) => {
      const result = await cli(args);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("Usage");
    },
  );
});

describe("validate and compile", () => {
  test("valid rules report how many there are", async () => {
    const result = await cli(["validate", rules]);
    expect(result).toMatchObject({
      code: 0,
      stdout: expect.stringMatching(/^OK, compiled to \d+ rules\./) as string,
    });
  });

  test("gates and budgets are counted next to rules, as compiled", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nodrail-cli-runs-"));
    writeFileSync(
      join(dir, "a.yaml"),
      [
        "- required_engine_version: 3",
        "- gate: Review first",
        "  command: { prefix: git push }",
        "  requires: [{ agent: reviewer, verdict: ship }]",
        "  otherwise: deny",
        "- budget: Run calls",
        "  per: run",
        "  tool_calls: 10",
        "  otherwise: deny",
        "",
      ].join("\n"),
    );
    expect((await cli(["validate", dir])).stdout).toContain(
      "OK, compiled to 0 rules, 2 gates and 1 budget.",
    );
  });

  test("a folder loads only its YAML files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nodrail-cli-dir-"));
    writeFileSync(
      join(dir, "a.yaml"),
      "- rule: A\n  command: ls\n  effect: allow\n",
    );
    writeFileSync(join(dir, "notes.txt"), "not rules");
    expect((await cli(["validate", dir])).stdout).toContain(
      "OK, compiled to 1 rule.",
    );
  });

  test("problems are reported by file and line, and exit 1", async () => {
    const result = await cli(["validate", broken]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("broken.yaml:1");
  });

  // The command turns this into exit 2, which blocks when it's a hook.
  test("a missing file stops with an error", async () => {
    await expect(
      cli(["validate", join(folder, "missing.yaml")]),
    ).rejects.toThrow(/ENOENT/);
  });

  test("compile prints the policy document", async () => {
    const result = await cli(["compile", rules]);
    expect(JSON.parse(result.stdout)).toMatchObject({ version: 1 });
  });
});

describe("eval", () => {
  const outcome = async (args: string[]) =>
    (
      JSON.parse((await cli(["eval", rules, ...args])).stdout) as {
        outcome: string;
      }
    ).outcome;

  test("a command", async () => {
    expect(await outcome(["--command", "git status"])).toBe("allow");
    expect(await outcome(["--command", "git push"])).toBe("none");
  });

  test("a tool call with params", async () => {
    const call = [
      "--tool",
      "stripe",
      "--operation",
      "refunds.create",
      "--kind",
      "invoice",
      "--resource",
      "INV-1",
    ];
    expect(await outcome([...call, "--params", '{"amount": 500}'])).toBe(
      "allow",
    );
    expect(await outcome([...call, "--params", '{"amount": 5000}'])).toBe(
      "none",
    );
    expect(await outcome(call)).toBe("none");
  });

  test("the agent decides which rules apply", async () => {
    const call = [
      "--tool",
      "github",
      "--operation",
      "issues.create",
      "--kind",
      "repository",
      "--resource",
      "a/b",
    ];
    expect(
      await outcome([
        ...call,
        "--agent",
        "support",
        "--now",
        "2026-11-10T12:00:00Z",
      ]),
    ).toBe("allow");
    expect(await outcome([...call, "--agent", "other"])).toBe("none");
  });

  test("an incomplete call prints the usage", async () => {
    expect((await cli(["eval", rules, "--tool", "stripe"])).code).toBe(2);
  });
});

describe("test", () => {
  test("passing cases exit 0", async () => {
    const cases = write(
      "pass.yaml",
      "- name: reads\n  call: { command: git status }\n  expect: allow\n",
    );
    const result = await cli(["test", rules, "--cases", cases]);
    expect(result).toMatchObject({
      code: 0,
      stdout: expect.stringContaining("1 of 1 passed") as string,
    });
  });

  test("a failing case says what it got, and exits 1", async () => {
    const cases = write(
      "fail.yaml",
      "- name: pushes\n  call: { command: git push }\n  expect: allow\n",
    );
    const result = await cli(["test", rules, "--cases", cases]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("FAIL pushes: expected allow, got none");
  });

  test("without --cases it prints the usage", async () => {
    expect((await cli(["test", rules])).code).toBe(2);
  });
});

describe("check and exec", () => {
  test("check exits 0 for an allowed command and 1 otherwise", async () => {
    expect((await cli(["check", rules, "--", "git", "status"])).code).toBe(0);
    const blocked = await cli(["check", rules, "--", "git", "push"]);
    expect(blocked.code).toBe(1);
    expect(blocked.stderr).toContain("Blocked");
  });

  test("exec refuses with 126 and runs what's allowed", async () => {
    expect((await cli(["exec", rules, "--", "git", "push"])).code).toBe(126);
    const allowList = write(
      "ls.yaml",
      "- rule: List\n  command: { prefix: ls }\n  effect: allow\n",
    );
    expect((await cli(["exec", allowList, "--", "ls", folder])).code).toBe(0);
    // The program's own exit code comes back, so it really ran.
    const missing = await cli([
      "exec",
      allowList,
      "--",
      "ls",
      join(folder, "nothing-here"),
    ]);
    expect([0, 126]).not.toContain(missing.code);
  });

  test("a program that can't start exits 127", async () => {
    const allowMissing = write(
      "missing.yaml",
      "- rule: Missing\n  command: { prefix: /nonexistent/program }\n  effect: allow\n",
    );
    expect(
      (await cli(["exec", allowMissing, "--", "/nonexistent/program"])).code,
    ).toBe(127);
  });

  test("with nothing to run it prints the usage", async () => {
    expect((await cli(["check", rules])).code).toBe(2);
  });
});

describe("hook", () => {
  const event = (command: string) =>
    JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command },
    });

  test("an allowed call passes quietly", async () => {
    expect(await cli(["hook", rules], event("git status"))).toEqual({
      code: 0,
      stdout: "",
      stderr: "",
    });
  });

  test("an unmatched call is denied, or asked with --unmatched ask", async () => {
    expect((await cli(["hook", rules], event("git push"))).stdout).toContain(
      '"deny"',
    );
    expect(
      (await cli(["hook", rules, "--unmatched", "ask"], event("git push")))
        .stdout,
    ).toContain('"ask"');
  });

  test("rules that can't load block with exit 2", async () => {
    expect((await cli(["hook", broken], event("git status"))).code).toBe(2);
  });
});
