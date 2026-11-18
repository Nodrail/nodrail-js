// The nodrail-policy command line, run in-process so every path is measured.
// Separate-process runs are covered by the docs and package tests.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

  // Exit 2, which blocks when it's a hook.
  test("a missing file stops with an error", async () => {
    const result = await cli(["validate", join(folder, "missing.yaml")]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/^ENOENT.*missing\.yaml'\n$/);
  });

  test("an unknown flag is a usage error", async () => {
    const result = await cli(["validate", rules, "--nope"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--nope");
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

  describe("--protect-list", () => {
    // A project whose setup files are listed, and rules that allow any write.
    const project = mkdtempSync(join(tmpdir(), "nodrail-protect-"));
    const anyWrite = write(
      "any-write.yaml",
      `- rule: Write anything
  tool: files
  operation: file.write
  resource: { kind: file, match: any }
  effect: allow
`,
    );
    mkdirSync(join(project, ".nodrail"));
    mkdirSync(join(project, "skills/style"), { recursive: true });
    const list = join(project, ".nodrail/protected.txt");
    writeFileSync(
      list,
      "# The setup's own files\nresources/team.yaml\n\nskills/style\n",
    );
    const writing = (path: string) =>
      JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: { file_path: join(project, path), content: "x" },
      });

    test.each(["resources/team.yaml", "skills/style/SKILL.md"])(
      "keeps %s from being written, whatever the rules allow",
      async (path) => {
        const result = await cli(
          ["hook", anyWrite, "--protect-list", list],
          writing(path),
        );
        expect(result.stdout).toContain('"deny"');
      },
    );

    test("leaves the rest to the rules", async () => {
      const result = await cli(
        ["hook", anyWrite, "--protect-list", list],
        writing("src/app.ts"),
      );
      expect(result).toMatchObject({ code: 0, stdout: "" });
    });

    test("a list that can't be read blocks with exit 2", async () => {
      const result = await cli(
        ["hook", anyWrite, "--protect-list", join(project, "missing.txt")],
        writing("src/app.ts"),
      );
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("can't read the protect list");
    });

    // Shell commands: a project with a setup, and rules that allow any command.
    const anyCommand = write(
      "any-command.yaml",
      `- rule: Any command
  tool: shell
  operation: command.run
  resource: { kind: command, match: any }
  effect: allow
- rule: Any compound
  tool: shell
  operation: command.compound
  resource: { kind: command, match: any }
  effect: allow
`,
    );
    mkdirSync(join(project, "resources"), { recursive: true });
    const running = (command: string) =>
      JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command },
        cwd: project,
      });
    const shell = (command: string) =>
      cli(["hook", anyCommand, "--protect-list", list], running(command));

    test.each([
      "cp /tmp/x resources/team.yaml",
      "sed -i s/a/b/ resources/team.yaml",
      "echo '{}' > .nodrail/protected.txt",
      "rm -r resources",
      "git checkout -- skills/style",
      "./node_modules/.bin/nodrail apply --yes",
      "npx @nodrail/cli apply --yes",
      "cd sub && ../nodrail-policy hook x",
      "cp evil ~/.nodrail/writes/x/setup.json",
    ])("denies %s, whatever the rules allow", async (command) => {
      const result = await shell(command);
      expect(result.stdout).toContain('"deny"');
      expect(result.stdout).toContain("part of the setup this hook enforces");
    });

    test.each(["npm test", "git add .", "git status", "cat src/app.ts"])(
      "leaves %s to the rules",
      async (command) => {
        expect(await shell(command)).toMatchObject({ code: 0, stdout: "" });
      },
    );
  });

  describe("--host codex", () => {
    const review = write(
      "review.yaml",
      `- rule: Pushes need a person
  command: { prefix: git push }
  effect: require_approval
`,
    );
    test("a review is denied, saying a person must approve it", async () => {
      const asked = await cli(["hook", review], event("git push"));
      expect(asked.stdout).toContain('"ask"');
      const codex = await cli(
        ["hook", review, "--host", "codex"],
        event("git push"),
      );
      expect(codex.stdout).toContain('"deny"');
      expect(codex.stdout).toContain("needs a person to review");
      expect(codex.stdout).toContain("This host can't ask a person");
      const unmatched = await cli(
        ["hook", review, "--host", "codex", "--unmatched", "ask"],
        event("ls"),
      );
      expect(unmatched.stdout).toContain('"deny"');
    });
  });
});
