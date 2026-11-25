import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { resolveConnection } from "../src/connection";
import { isSafeUrl } from "../src/index";
import { describeToolCall, HOOK_VERSION, runHook } from "../src/hooks";
import { SDK_VERSION } from "../src/sdk";
import { claudeCodeHooks, codexGovernedTools, codexHooks } from "../src/setup";
import { fakeNodrail } from "./support/fake-nodrail";

// Paths take the machine's own form: /work here, D:\work on Windows.
const work = resolve("/work");

const event = (tool_name: string, tool_input: object) =>
  JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_name,
    tool_input,
    tool_use_id: "call_1",
    cwd: work,
  });

const env = {
  NODRAIL_URL: "https://app.nodrail.com",
  NODRAIL_CREDENTIAL: "c",
  NODRAIL_WAIT_SECONDS: "0",
};
const reasonOf = (stdout: string) =>
  (
    JSON.parse(stdout) as {
      hookSpecificOutput: { permissionDecisionReason: string };
    }
  ).hookSpecificOutput.permissionDecisionReason;

const patch = (...lines: string[]) =>
  ["*** Begin Patch", ...lines, "*** End Patch"].join("\n");

describe("Codex's apply_patch", () => {
  test.each([
    ["Add", "file.write"],
    ["Update", "file.edit"],
    ["Delete", "file.delete"],
  ])(
    "one %s is ruled like the same change from any agent",
    (verb, operation) => {
      const described = describeToolCall(
        "apply_patch",
        {
          command: patch(`*** ${verb} File: src/a.ts`, "+hello"),
        },
        work,
      );
      expect(described).toMatchObject({
        tool: "files",
        operation,
        resource: { kind: "file", id: join(work, "src", "a.ts") },
        params: { path: join(work, "src", "a.ts") },
      });
    },
  );

  test("never carries what the patch writes", () => {
    const described = describeToolCall(
      "apply_patch",
      {
        command: patch("*** Update File: a.ts", "-SECRETOLD", "+SECRETNEW"),
      },
      work,
    );
    expect(JSON.stringify(described)).not.toContain("SECRET");
  });

  test.each([
    [
      "several files",
      patch("*** Update File: src/a.ts", "*** Update File: ../etc/passwd"),
    ],
    ["a rename", patch("*** Update File: src/a.ts", "*** Move to: /etc/a.ts")],
  ])("%s can't ride on a rule for one path", (_label, command) => {
    const described = describeToolCall("apply_patch", { command }, work);
    expect(described?.operation).toBe("file.patch");
    expect(described?.resource.id).toMatch(/^patch:sha256:/);
    expect(described?.params.path_parts).toContain("etc");
  });

  test.each([
    ["nothing", {}],
    ["no files in it", { command: "*** Begin Patch\n*** End Patch" }],
  ])("with %s it can't be described, so it is blocked", (_label, input) => {
    expect(describeToolCall("apply_patch", input, work)).toBeNull();
  });

  test("a relative path with no working folder is not guessed", () => {
    expect(
      describeToolCall("apply_patch", {
        command: patch("*** Add File: a.ts"),
      }),
    ).toBeNull();
  });
});

describe("the hook as Codex runs it", () => {
  test("identifies itself as Codex", async () => {
    const adapters: unknown[] = [];
    const server = fakeNodrail();
    await runHook(event("Bash", { command: "ls" }), env, {
      agent: "codex",
      fetch: ((url: string, init: RequestInit) => {
        if (String(url).endsWith("/actions"))
          adapters.push(
            (JSON.parse(init.body as string) as { adapter_version: unknown })
              .adapter_version,
          );
        return server.fetch(url, init);
      }) as unknown as typeof fetch,
    });
    expect(adapters).toEqual([`codex-hook/${HOOK_VERSION}`]);
  });

  test("sends the run, so command gates and run budgets apply", async () => {
    const server = fakeNodrail();
    await runHook(
      event("Bash", { command: "git push" }),
      { ...env, NODRAIL_RUN: "ENG-9" },
      { agent: "codex", fetch: server.fetch },
    );
    // Codex doesn't say which subagent made a call, so every call is the main agent's.
    expect(
      server.requests.find((request) => request.path === "/actions")?.body.run,
    ).toEqual({ key: "ENG-9", subject: null });
  });

  test(
    "answers before Codex's own time limit would let the tool run",
    {
      timeout: 10_000,
    },
    async () => {
      const result = await runHook(event("Bash", { command: "ls" }), env, {
        agent: "codex",
        deadlineMs: 5,
        fetch: (() => new Promise(() => undefined)) as unknown as typeof fetch,
      });
      expect(result.exitCode).toBe(0);
      expect(reasonOf(result.stdout)).toContain("TIMED_OUT");
    },
  );

  test.each(["codex", "claude-code"] as const)(
    "%s: a hold from an older server is denied at once, never waited for",
    async (agent) => {
      const server = fakeNodrail(() => "APPROVAL_PENDING");
      const result = await runHook(
        event("Bash", { command: "rm -rf build" }),
        env,
        {
          agent,
          fetch: server.fetch,
        },
      );
      expect(reasonOf(result.stdout)).toContain("APPROVAL_PENDING");
      expect(reasonOf(result.stdout)).toContain("denied");
      expect(
        server.requests.filter((request) => request.path.endsWith("/withdraw")),
      ).toHaveLength(0);
    },
  );

  test("a failed command is reported as failed", async () => {
    const reports: string[] = [];
    const action = {
      action_id: "a",
      permit_id: "p",
      code: "READY",
      installation_id: "i",
      descriptor_digest: "d",
      action_digest: "d",
      reference: "r",
    };
    const send = (async (url: string, init: RequestInit) => {
      if (String(url).endsWith("/reports"))
        reports.push(
          (JSON.parse(init.body as string) as { outcome: string }).outcome,
        );
      return new Response(JSON.stringify(action), { status: 200 });
    }) as unknown as typeof fetch;
    await runHook(
      JSON.stringify({
        hook_event_name: "PostToolUse",
        tool_use_id: "call_1",
        tool_response: { exit_code: 1 },
      }),
      env,
      { agent: "codex", fetch: send },
    );
    expect(reports).toEqual(["failure"]);
  });
});

describe("telling people when setup is wrong", () => {
  const start = JSON.stringify({ hook_event_name: "SessionStart" });

  test("says so at the start of a session with no credential", async () => {
    const result = await runHook(start, { NODRAIL_HOME: "/nonexistent" });
    expect(JSON.parse(result.stdout)).toMatchObject({
      systemMessage: expect.stringContaining("not connected") as string,
    });
  });

  test("says so when the credential is refused", async () => {
    const result = await runHook(start, env, {
      fetch: (async () =>
        new Response(JSON.stringify({ error: { code: "UNAUTHENTICATED" } }), {
          status: 401,
        })) as unknown as typeof fetch,
    });
    expect(result.stdout).toContain("refused");
    expect(result.exitCode).toBe(0);
  });

  test("stays quiet when all is well", async () => {
    const result = await runHook(start, env, { fetch: fakeNodrail().fetch });
    expect(result.stdout).toBe("");
  });
});

describe("finding the connection", () => {
  const saved = () => {
    const home = mkdtempSync(join(tmpdir(), "nodrail-test-"));
    writeFileSync(join(home, "credential"), "  from-file\n");
    return home;
  };

  test("reads complete plugin settings and canonicalizes their origin", () => {
    expect(
      resolveConnection({
        CLAUDE_PLUGIN_OPTION_CREDENTIAL: "plugin",
        CLAUDE_PLUGIN_OPTION_URL: "HTTPS://Self-Hosted.Example:443/",
      }),
    ).toEqual({ url: "https://self-hosted.example", credential: "plugin" });
  });

  test("accepts the same complete pair in the environment and plugin settings", () => {
    expect(
      resolveConnection({
        NODRAIL_URL: "https://nodrail.test",
        NODRAIL_CREDENTIAL: "match",
        CLAUDE_PLUGIN_OPTION_URL: "https://NODRAIL.test:443/",
        CLAUDE_PLUGIN_OPTION_CREDENTIAL: "match",
      }),
    ).toEqual({ url: "https://nodrail.test", credential: "match" });
  });

  test("configuration errors surface at session start without requests or reports", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const environment = { NODRAIL_CREDENTIAL: "unpaired" };
    const run = (name: string) =>
      runHook(JSON.stringify({ hook_event_name: name }), environment, {
        fetch,
      });
    expect((await run("SessionStart")).stdout).toContain(
      "Pair NODRAIL_URL with NODRAIL_CREDENTIAL",
    );
    expect((await run("PostToolUse")).stdout).toBe("");
    expect(fetch).not.toHaveBeenCalled();
  });

  test("reads the saved Cloud credential", () => {
    expect(resolveConnection({ NODRAIL_HOME: saved() }).credential).toBe(
      "from-file",
    );
  });

  test.each([
    { NODRAIL_CREDENTIAL: "env" },
    { NODRAIL_URL: "https://self-hosted.example" },
    {
      NODRAIL_URL: "https://self-hosted.example",
      CLAUDE_PLUGIN_OPTION_CREDENTIAL: "plugin",
    },
    {
      NODRAIL_URL: "https://self-hosted.example",
      NODRAIL_CREDENTIAL: "env",
      CLAUDE_PLUGIN_OPTION_URL: "https://plugin.example",
      CLAUDE_PLUGIN_OPTION_CREDENTIAL: "plugin",
    },
  ])(
    "blocks incomplete and conflicting pairs before sending a credential",
    async (settings) => {
      const environment = { NODRAIL_HOME: saved(), ...settings };
      expect(resolveConnection(environment)).toMatchObject({
        credential: null,
      });
      const fetch = vi.fn<typeof globalThis.fetch>();
      const result = await runHook(
        event("Bash", { command: "ls" }),
        environment,
        { fetch },
      );
      expect(reasonOf(result.stdout)).toContain(
        "Pair NODRAIL_URL with NODRAIL_CREDENTIAL",
      );
      expect(reasonOf(result.stdout)).toContain(
        "CLAUDE_PLUGIN_OPTION_URL with CLAUDE_PLUGIN_OPTION_CREDENTIAL",
      );
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  test("nothing configured means no credential", () => {
    expect(resolveConnection({ NODRAIL_HOME: "/nonexistent" }).credential).toBe(
      null,
    );
  });
});

describe("the hook declarations", () => {
  const codex = new RegExp(codexGovernedTools);

  test.each(["Bash", "apply_patch", "mcp__github__create_issue"])(
    "Codex governs %s",
    (tool) => expect(codex.test(tool)).toBe(true),
  );

  test.each(["update_plan", "view_image"])("Codex leaves %s alone", (tool) =>
    expect(codex.test(tool)).toBe(false),
  );

  test("Codex's matcher avoids what its regex engine lacks", () => {
    expect(codexGovernedTools).not.toMatch(/\(\?[!=<]/);
  });

  test("each outlasts the hook's own deadline, and nothing waits longer", () => {
    for (const hooks of [claudeCodeHooks({ command: "x" }), codexHooks("x")]) {
      expect(hooks.PreToolUse[0]?.hooks[0]?.timeout).toBeGreaterThan(25);
      expect(hooks.PreToolUse[0]?.hooks[0]?.timeout).toBeLessThanOrEqual(30);
    }
  });

  test("Claude Code governs starting a subagent, and records its steps", () => {
    const hooks = claudeCodeHooks({ command: "x" });
    const governed = new RegExp(hooks.PreToolUse[0]?.matcher ?? "");
    expect(governed.test("Agent")).toBe(true);
    // Task is the earlier name of Agent: governed the same way.
    expect(governed.test("Task")).toBe(true);
    expect(describeToolCall("Task", { subagent_type: "qa" })).toMatchObject({
      tool: "claude-code",
      operation: "agent",
      resource: { kind: "agent", id: "qa" },
    });
    expect(hooks.SubagentStart[0]?.hooks[0]).toMatchObject({ command: "x" });
    expect(hooks.SubagentStop[0]?.hooks[0]).toMatchObject({ command: "x" });
  });

  test("Claude Code blocks if the check itself fails", () => {
    expect(
      claudeCodeHooks({ command: "x" }).PreToolUse[0]?.hooks[0],
    ).toMatchObject({ onFailure: "block" });
  });
});

test("the versions sent to Nodrail are the package's version", () => {
  const { version } = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string };
  expect([SDK_VERSION, HOOK_VERSION]).toEqual([version, version]);
});

describe("the credential never travels in the clear", () => {
  test.each([
    ["http://nodrail.example.com", false],
    ["http://10.0.0.5:3000", false],
    ["ftp://x", false],
    ["not a url", false],
    ["https://app.nodrail.com", true],
    ["http://localhost:3000", true],
    ["http://127.0.0.1:3000", true],
    ["http://[::1]:3000", true],
  ])("%s is %s", (url, safe) => {
    expect(isSafeUrl(url)).toBe(safe);
  });

  test("an http address elsewhere blocks without sending anything", async () => {
    const sent: string[] = [];
    const result = await runHook(
      event("Bash", { command: "ls" }),
      {
        NODRAIL_CREDENTIAL: "secret-credential",
        NODRAIL_URL: "http://nodrail.example.com",
        NODRAIL_WAIT_SECONDS: "0",
      },
      {
        fetch: (async (url: string) => {
          sent.push(url);
          return new Response("{}");
        }) as unknown as typeof fetch,
      },
    );
    expect(sent).toEqual([]);
    expect(reasonOf(result.stdout)).toContain("https");
  });
});

describe("reads are checked on the machine", () => {
  // No credential and no server: a read never needs Nodrail to answer.
  const offline = { NODRAIL_HOME: "/nonexistent" };
  const noServer = (() => {
    throw new Error("a read must not contact Nodrail");
  }) as unknown as typeof fetch;

  test.each([
    ["Read", { file_path: ".env.production" }],
    ["Read", { file_path: "/home/a/.ssh/id_rsa" }],
    ["Read", { file_path: "/home/a/.codex/auth.json" }],
    ["Grep", { pattern: "KEY", glob: ".env*" }],
    ["Glob", { pattern: "**/.aws/*" }],
  ])("%s %j is denied", async (tool, input) => {
    const result = await runHook(event(tool, input), offline, {
      fetch: noServer,
    });
    expect(reasonOf(result.stdout)).toContain("credentials");
  });

  test.each([
    ["Read", { file_path: "src/a.ts" }],
    ["Grep", { pattern: "TODO", glob: "*.ts" }],
  ])("%s %j goes ahead quietly", async (tool, input) => {
    const result = await runHook(event(tool, input), offline, {
      fetch: noServer,
    });
    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  });
});
