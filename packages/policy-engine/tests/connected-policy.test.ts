import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { stringify } from "yaml";
import { hookCommand, type HookIo } from "../src/hook-command.ts";
import { readHookConnection } from "../src/hook-connection.ts";
import { loadHookPolicy } from "../src/hook-policy.ts";
import { spoolFolder } from "../src/telemetry.ts";

const source = "- rule: Inspect\n  command: { prefix: ls }\n  effect: allow\n";
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

function installed(enforce: "on" | "watch" = "on") {
  const root = mkdtempSync(join(tmpdir(), "nodrail-installed-"));
  const home = join(root, "host");
  const folder = join(root, ".nodrail");
  mkdirSync(folder);
  const file = join(folder, "connect.json");
  const credential = { fromEnv: "HOST_CREDENTIAL" };
  const env = {
    HOST_CREDENTIAL: "fixture-token",
    NODRAIL_RUN: "test",
    HOME: home,
  };
  const manifest = stringify({
    connect: {
      decide: "cloud",
      workspace: "fixture",
      environment: "dev",
      credential,
      enforce,
    },
  });
  const config = {
    decide: "cloud",
    enforce,
    url: "https://app.nodrail.com",
    credential,
    workspace: "fixture",
    environment: "dev",
    lock: "../nodrail.lock.yaml",
    workspace_revision: "4".repeat(64),
    policy_digest: sha256(source),
  } as const;
  writeFileSync(join(root, "nodrail.yaml"), manifest);
  writeFileSync(
    join(root, "nodrail.lock.yaml"),
    stringify({
      manifest: { sha256: sha256(manifest) },
      effective: { sha256: config.policy_digest },
      workspace: { sha256: config.workspace_revision },
    }),
  );
  const writeConfig = (change: object = {}) =>
    writeFileSync(file, JSON.stringify({ ...config, ...change }));
  writeConfig();
  return { root, file, folder, home, config, env, writeConfig };
}

describe("connected policy", () => {
  test("the applied enforcement mode and manifest must match the lock", () => {
    const setup = installed();
    expect(readHookConnection(setup.file)).toEqual(setup.config);
    setup.writeConfig({ enforce: "watch" });
    expect(() => readHookConnection(setup.file)).toThrow("enforcement mode");
    // Change both projections without regenerating the lock.
    writeFileSync(join(setup.root, "nodrail.yaml"), "connect: {}");
    expect(() => readHookConnection(setup.file)).toThrow("manifest differs");
  });

  test.each([
    [304, null, "HTTP 304"],
    [429, null, "no cached policy"],
    [200, "[invalid", "invalid policy"],
    [200, '{"source":null}', "no published source"],
  ] as const)(
    "handles a cold policy response with HTTP %i",
    async (status, body, reason) => {
      const { file, home, env } = installed();
      const result = await loadHookPolicy(file, readHookConnection(file), env, {
        home,
        fetch: async (_url, init) => {
          expect(new Headers(init?.headers).has("if-none-match")).toBe(false);
          return new Response(body, { status });
        },
      });
      expect(result).toContain(reason);
    },
  );

  test("only uses a 304 after sending a validator from a verified response", async () => {
    const { file, home, config, env } = installed();
    const settings = readHookConnection(file);
    const pull = (fetch: typeof globalThis.fetch) =>
      loadHookPolicy(file, settings, env, { home, fetch });
    const headers = { etag: '"one"' };
    const first = await pull(async () =>
      Response.json(
        { source: { text: source, digest: config.policy_digest } },
        { headers },
      ),
    );
    expect(first).toMatchObject({ digest: config.policy_digest });
    const seen: (string | null)[] = [];
    const notModified = await pull(async (_url, init) => {
      seen.push(new Headers(init?.headers).get("if-none-match"));
      return new Response(null, { status: 304, headers });
    });
    if (typeof first === "string" || typeof notModified === "string")
      throw new Error("the verified cache should supply a compiled policy");
    expect(notModified.document).toEqual(first.document);
    expect(notModified.digest).toBe(config.policy_digest);
    expect(seen).toEqual([headers.etag]);
  });

  test("watch audits a broken connections file and preserves a readable custom protect list", async () => {
    const { root, folder, file, home, env } = installed("watch");
    const list = join(folder, "protected.txt");
    writeFileSync(list, "custom-setup.txt\n");
    const out: string[] = [];
    const errors: string[] = [];
    const calls: unknown[] = [];
    const io: HookIo = {
      readStdin: async () =>
        JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: "Write",
          tool_input: { file_path: "custom-setup.txt", content: "overwrite" },
          cwd: root,
        }),
      write: (text) => out.push(text),
      writeError: (text) => errors.push(text),
      fetch: async (url) => {
        calls.push(url);
        return new Response(null, { status: 403 });
      },
      home,
      env,
    };
    const code = await hookCommand(
      {
        values: {
          connect: file,
          "protect-list": list,
          connections: join(folder, "missing.json"),
        },
        now: new Date(),
        paths: [],
      },
      io,
      async () => null,
    );
    expect(code).toBe(0);
    expect(out.join("")).toContain('"permissionDecision":"deny"');
    expect(errors.join("")).toContain("can't read the connections");
    expect(calls).toEqual([]);
    const audit = spoolFolder(home, file, "watch-audit");
    expect(readFileSync(join(audit, "spool.jsonl"), "utf8")).toContain(
      "evaluation_failure",
    );
  });
});
