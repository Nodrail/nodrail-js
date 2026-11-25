import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { recordAppliedHook } from "@nodrail/policy-engine/command-line";
import { runHook } from "../src/hooks";

const temporary: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const path of temporary.splice(0))
    rmSync(path, { recursive: true, force: true });
});

function project() {
  const home = mkdtempSync(join(tmpdir(), "nodrail-plugin-home-"));
  const root = mkdtempSync(join(tmpdir(), "nodrail-plugin-project-"));
  temporary.push(home, root);
  vi.stubEnv(process.platform === "win32" ? "USERPROFILE" : "HOME", home);
  mkdirSync(join(root, ".claude"));
  mkdirSync(join(root, ".nodrail"));
  const connection = join(root, ".nodrail/connect.json");
  writeFileSync(connection, '{"decide":"local"}');
  const settings = {
    hooks: {
      PreToolUse: [
        {
          matcher: "*",
          hooks: [
            {
              type: "command",
              command:
                'nodrail policy hook "$CLAUDE_PROJECT_DIR/.nodrail/effective.yaml"',
              onFailure: "block",
            },
          ],
        },
      ],
    },
  };
  const settingsPath = join(root, ".claude/settings.json");
  writeFileSync(settingsPath, JSON.stringify(settings));
  const env = {
    CLAUDE_PROJECT_DIR: root,
    NODRAIL_URL: "https://standalone.test",
    NODRAIL_CREDENTIAL: "standalone",
  };
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(new Response(null, { status: 403 }));
  const event = JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "ls" },
    tool_use_id: "call",
    session_id: "session",
    cwd: root,
  });
  return {
    connection,
    env,
    settingsPath,
    fetch,
    apply: () => recordAppliedHook(home, root, settings),
    start: () =>
      runHook(
        JSON.stringify({
          hook_event_name: "SessionStart",
          cwd: root,
          session_id: "session",
          source: "startup",
        }),
        env,
        { fetch },
      ),
    run: (override?: typeof env & { NODRAIL_REQUIRE_STANDALONE: string }) =>
      runHook(event, override ?? env, { fetch }),
  };
}

test("an unapplied checkout cannot replace standalone enforcement", async () => {
  const p = project();
  expect((await p.run()).stdout).toContain('"permissionDecision":"deny"');
  expect(p.fetch).toHaveBeenCalledOnce();
});

test("only verified active settings take over, and operators can require standalone enforcement", async () => {
  const p = project();
  p.apply();
  await p.start();
  expect((await p.run()).stdout).toBe("");
  expect(p.fetch).not.toHaveBeenCalled();

  expect(
    (await p.run({ ...p.env, NODRAIL_REQUIRE_STANDALONE: "1" })).stdout,
  ).toContain('"permissionDecision":"deny"');
  expect(p.fetch).toHaveBeenCalledOnce();

  writeFileSync(p.settingsPath, "{}");
  expect((await p.run()).stdout).toContain('"permissionDecision":"deny"');
  expect(p.fetch).toHaveBeenCalledTimes(2);
});

test("a session already running when apply installs the project hook keeps standalone enforcement", async () => {
  const p = project();
  await p.start();
  p.apply();
  expect((await p.run()).stdout).toContain('"permissionDecision":"deny"');
});

test("changed policy inputs invalidate the apply record", async () => {
  const p = project();
  p.apply();
  await p.start();
  writeFileSync(p.connection, '{"decide":"cloud"}');
  expect((await p.run()).stdout).toContain('"permissionDecision":"deny"');
  expect(p.fetch).toHaveBeenCalledOnce();
});
