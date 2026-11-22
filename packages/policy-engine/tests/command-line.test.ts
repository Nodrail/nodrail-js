// The nodrail-policy command line, run in-process so every path is measured.
// Separate-process runs are covered by the docs and package tests.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
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

  test("an unmatched call is denied, or let through with --unmatched allow", async () => {
    expect((await cli(["hook", rules], event("git push"))).stdout).toContain(
      '"deny"',
    );
    expect(
      await cli(["hook", rules, "--unmatched", "allow"], event("git push")),
    ).toEqual({ code: 0, stdout: "", stderr: "" });
  });

  test("--unmatched ask was removed: the hook stops with exit 2 and says what to use", async () => {
    const asked = await cli(
      ["hook", rules, "--unmatched", "ask"],
      event("git push"),
    );
    expect(asked).toMatchObject({ code: 2, stdout: "" });
    expect(asked.stderr).toContain(
      "--unmatched ask was removed: nothing waits for a person. Use --unmatched deny (the default), or allow",
    );
    const other = await cli(
      ["hook", rules, "--unmatched", "maybe"],
      event("git push"),
    );
    expect(other).toMatchObject({ code: 2, stdout: "" });
    expect(other.stderr).toContain("--unmatched is deny or allow, not maybe");
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
      "cat skills/style/SKILL.md > skills/style/x.md",
      "cat skills/style/SKILL.md; rm -r resources",
    ])("denies %s, whatever the rules allow", async (command) => {
      const result = await shell(command);
      expect(result.stdout).toContain('"deny"');
      expect(result.stdout).toContain("part of the setup this hook enforces");
    });

    // Codex loads a skill by reading it through its shell: a read in a shape
    // known exactly changes nothing, so the file rules decide it.
    test.each([
      "cat skills/style/SKILL.md",
      "sed -n '1,20p' resources/team.yaml",
    ])("leaves the read %s to the file rules", async (command) => {
      expect((await shell(command)).stdout).not.toContain("part of the setup");
    });

    test.each(["npm test", "git add .", "git status", "cat src/app.ts"])(
      "leaves %s to the rules",
      async (command) => {
        expect(await shell(command)).toMatchObject({ code: 0, stdout: "" });
      },
    );
  });

  // R364: the run ledger holds the steps, reservations and evidence gates
  // read, so an agent never writes it, wherever it is.
  describe("the run ledger is always protected", () => {
    const repo = mkdtempSync(join(tmpdir(), "nodrail-ledger-"));
    spawnSync("git", ["init", "-q"], { cwd: repo });
    mkdirSync(join(repo, ".nodrail"));
    const list = join(repo, ".nodrail/protected.txt");
    writeFileSync(
      list,
      "# Not naming the ledger\n.claude\nresources/team.yaml\n",
    );
    const evidence = join(repo, ".git/nodrail/runs/evidence/ci-tests.jsonl");
    const anything = write(
      "anything.yaml",
      ["file.write", "file.edit", "file.patch"]
        .map(
          (operation) => `- rule: Change files ${operation}
  tool: files
  operation: ${operation}
  resource: { kind: file, match: any }
  effect: allow
`,
        )
        .join("") +
        `- rule: Any compound
  tool: shell
  operation: command.compound
  resource: { kind: command, match: any }
  effect: allow
- rule: Any command
  tool: shell
  operation: command.run
  resource: { kind: command, match: any }
  effect: allow
`,
    );
    const hook = (tool_name: string, tool_input: object) =>
      cli(
        ["hook", anything, "--protect-list", list],
        JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name,
          tool_input,
          cwd: repo,
        }),
      );

    test.each([
      ["Write", { file_path: evidence, content: "{}\n" }],
      ["Edit", { file_path: evidence, old_string: "a", new_string: "b" }],
      [
        "Bash",
        { command: "echo '{}' >> .git/nodrail/runs/evidence/ci-tests.jsonl" },
      ],
      ["Bash", { command: `cp /tmp/forged ${evidence}` }],
      ["Bash", { command: "rm -r .git/nodrail" }],
      // R374: all of git's folder, and no splicing or wildcard around it.
      [
        "Write",
        { file_path: join(repo, ".git/hooks/pre-commit"), content: "x" },
      ],
      ["Write", { file_path: join(repo, ".git/config"), content: "x" }],
      [
        "Bash",
        {
          command:
            'cp sub/forged.jsonl ".git/nod""rail/runs/evidence/ci-tests.jsonl"',
        },
      ],
      ["Bash", { command: "cp x .gi?/nodrail/runs/evidence/ci-tests.jsonl" }],
      ["Bash", { command: "cp x .g*/hooks/pre-commit" }],
      ["Bash", { command: "rm -r .[g]it" }],
      ["Bash", { command: "cp x '.git'/config" }],
      ["Bash", { command: "echo x > .git/hooks/post-checkout" }],
      ["Bash", { command: "cp x .nod*/protected.txt" }],
    ])("denies %s %j, whatever the rules allow", async (tool, input) => {
      const { stdout } = await hook(tool, input);
      expect(stdout).toContain('"deny"');
      expect(stdout).toMatch(/holds the rules|part of the setup/);
    });

    test.each([
      [`*** Add File: ${evidence}\n+{}`],
      [
        `*** Add File: ${join(repo, "src/a.ts")}\n+x\n*** Add File: ${evidence}\n+{}`,
      ],
    ])("denies a patch that touches it: %s", async (body) => {
      const patch = `*** Begin Patch\n${body}\n*** End Patch`;
      const result = await hook("apply_patch", { command: patch });
      expect(result.stdout).toContain("deny");
      expect(result.stdout).toContain("holds the rules");
    });

    test("NODRAIL_LEDGER moves it, and the protection with it", async () => {
      const moved = join(repo, "ledger-here");
      process.env.NODRAIL_LEDGER = moved;
      try {
        const result = await hook("Write", {
          file_path: join(moved, "evidence/ci-tests.jsonl"),
          content: "{}\n",
        });
        expect(result.stdout).toContain('"deny"');
        expect(result.stdout).toContain("holds the rules");
      } finally {
        delete process.env.NODRAIL_LEDGER;
      }
    });

    test("leaves the rest of the repository to the rules", async () => {
      expect(
        await hook("Write", {
          file_path: join(repo, "src/app.ts"),
          content: "x",
        }),
      ).toMatchObject({ code: 0, stdout: "" });
      expect(await hook("Bash", { command: "git status" })).toMatchObject({
        code: 0,
        stdout: "",
      });
    });

    // R376: links pointing at a root, and trees copied onto one.
    describe("links and tree copies", () => {
      mkdirSync(join(repo, "sub/deep"), { recursive: true });
      // Empty now: only an earlier part of the line would fill it (R377).
      mkdirSync(join(repo, "sub/x"), { recursive: true });
      mkdirSync(join(repo, "sub/fake/.git"), { recursive: true });
      mkdirSync(join(repo, "sub/fake/.claude"), { recursive: true });
      writeFileSync(join(repo, "sub/file.txt"), "x");
      const forged = "sub/forged.jsonl";

      test.each([
        `ln -s ../.git sub/g5 && cp ${forged} sub/g5/nodrail/runs/evidence/ci-tests.jsonl`,
        `ln -s ../.git sub/g5; cp ${forged} sub/g5/nodrail/runs/evidence/ci-tests.jsonl`,
        `mkdir sub/m && ln -s ../../.git sub/m/l && cp ${forged} sub/m/l/nodrail/x`,
        "ln -s .. sub/up && cp sub/ok.txt sub/up/.git/nodrail/x",
        "ln -s ../.git sub/g5",
        `ln -s ${repo} sub/whole`,
        "cp -s .git/config sub/c",
        "cp -r sub/fake/.git .",
        "cp -r sub/fake/.claude .",
        "rsync -a sub/fake/ .",
        "cp -R sub/fake/. ./",
        "mv sub/fake/.claude .",
        "tar -xf sub/a.tar",
        "unzip sub/a.zip -d .",
        "cp -r sub/missing/. .",
        "cp -r sub/file.txt .git/",
        "rsync -a sub/deep/ .nodrail/",
        // R377: an earlier part can fill the source before the copy runs.
        "cp -r sub/deep sub/x/.claude && cp -R sub/x/. ./",
        "mkdir -p sub/x/.claude && cp sub/disable.json sub/x/.claude/settings.local.json && cp -R sub/x/. ./",
        "mv sub/deep sub/x/.claude && rsync -a sub/x/ ./",
        "cp -r sub/deep sub/x/.claude & cp -R sub/x/. ./",
      ])("denies %s", async (command) => {
        const { stdout } = await hook("Bash", { command });
        expect(stdout).toContain('"deny"');
        expect(stdout).toContain("part of the setup");
      });
    });

    test("a wildcard through a link to .git counts as .git", async () => {
      if (process.platform === "win32") return;
      mkdirSync(join(repo, "links"), { recursive: true });
      symlinkSync("../.git", join(repo, "links/gl"));
      const { stdout } = await hook("Bash", {
        command: "cp x links/g*/nodrail/runs/evidence/ci-tests.jsonl",
      });
      expect(stdout).toContain("part of the setup");
    });

    test("a moved ledger is kept from splicing and wildcards too", async () => {
      process.env.NODRAIL_LEDGER = join(repo, "sub/altledger");
      try {
        for (const command of [
          'cp x "sub/alt""ledger/evidence/ci-tests.jsonl"',
          "cp x sub/alt*/evidence/ci-tests.jsonl",
          "rm -r sub/*",
        ])
          expect((await hook("Bash", { command })).stdout).toContain(
            "part of the setup",
          );
      } finally {
        delete process.env.NODRAIL_LEDGER;
      }
    });

    test.each([
      "cp a.txt b.txt",
      "cp src/*.ts dist/",
      "rm -f *.log",
      "ls *",
      'cp "src/a""b.ts" dist/',
      "cp -r sub/deep logs/",
      "ln -s ../shared/lib.ts src/lib.ts",
      "mv a.txt b.txt",
      "mv sub/file.txt .",
      "rsync -a src/ dist/",
      "tar -xf sub/a.tar -C vendor",
      "cp sub/file.txt .",
      "cp -r sub/deep .",
      "cp -R sub/deep/. ./",
      "rsync -a sub/deep/ .",
      "mv sub/deep .",
      "unzip sub/a.zip -d vendor",
      "mkdir -p dist && rsync -a src/ dist/",
      "mkdir -p dist && cp -R sub/deep/. dist/",
    ])("leaves %s to the rules", async (command) => {
      expect(await hook("Bash", { command })).toMatchObject({
        code: 0,
        stdout: "",
      });
    });
  });

  describe("--host codex", () => {
    const pushes = write(
      "pushes.yaml",
      `- rule: Never push
  command: { prefix: git push }
  effect: deny
`,
    );
    test("a deny names its rule, as on Claude Code", async () => {
      const codex = await cli(
        ["hook", pushes, "--host", "codex"],
        event("git push"),
      );
      expect(codex.stdout).toContain('"deny"');
      expect(codex.stdout).toContain("rule never-push denies");
      const unmatched = await cli(
        ["hook", pushes, "--host", "codex"],
        event("ls"),
      );
      expect(unmatched.stdout).toContain("no rule covers");
    });
  });
});
