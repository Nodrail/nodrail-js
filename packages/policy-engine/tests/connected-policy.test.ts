import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { stringify } from "yaml";
import { hookCommand, type HookIo } from "../src/hook-command.ts";
import { readHookConnection } from "../src/hook-connection.ts";
import { writeHostCredential } from "../src/host-credentials.ts";
import { POLICY_CHECK_FILE } from "../src/hook-policy-status.ts";
import { loadHookPolicy } from "../src/hook-policy.ts";
import { spoolFolder } from "../src/telemetry.ts";

const source = "- rule: Inspect\n  command: { prefix: ls }\n  effect: allow\n";
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

function installed(
  enforce: "on" | "watch" = "on",
  projectId?: string,
  manifestUrl?: string,
) {
  const root = mkdtempSync(join(tmpdir(), "nodrail-installed-"));
  const home = join(root, "host");
  const folder = join(root, ".nodrail");
  mkdirSync(folder);
  const file = join(folder, "connect.json");
  const credential = projectId ? undefined : { fromEnv: "HOST_CREDENTIAL" };
  const env = {
    HOST_CREDENTIAL: "fixture-token",
    NODRAIL_URL: "https://app.nodrail.com",
    NODRAIL_RUN: "test",
    HOME: home,
  };
  const manifest = stringify({
    ...(projectId ? { id: projectId } : {}),
    connect: {
      ...(manifestUrl ? { url: manifestUrl } : {}),
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
    ...(projectId ? { project_id: projectId } : {}),
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

function pullFrom({ file, home, env }: ReturnType<typeof installed>) {
  const settings = readHookConnection(file);
  return (fetch: typeof globalThis.fetch) =>
    loadHookPolicy(file, settings, env, { home, fetch });
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

  test("compares the canonical origin from the locked manifest and applied hook", () => {
    const setup = installed("on", undefined, "https://APP.nodrail.com:443/");
    expect(readHookConnection(setup.file)).toMatchObject({
      url: setup.config.url,
    });
  });

  test.each([
    { url: "https://other.example" },
    { workspace: "other" },
    { environment: "prod" },
    { credential: { fromEnv: "OTHER" } },
    { lock: "../other.lock.yaml" },
    { workspace_revision: "c".repeat(64) },
    { policy_digest: "d".repeat(64) },
    { project_id: "63ae0d29-ab7d-4487-83d0-1780ba28441a" },
  ])("rejects a changed projection with %o", (change) => {
    const setup = installed();
    setup.writeConfig(change);
    expect(() => readHookConnection(setup.file)).toThrow(
      "differs from the repository lock",
    );
  });

  test("requires the enrolled project ID even if the projected connection omits it", () => {
    const setup = installed("on", "63ae0d29-ab7d-4487-83d0-1780ba28441a");
    setup.writeConfig({ project_id: undefined });
    expect(() => readHookConnection(setup.file)).toThrow(
      "differs from the repository lock",
    );
  });

  test("legacy projections require explicit opt-in and still match the lock", () => {
    const { file, config } = installed();
    const { enforce, url, credential, workspace, environment } = config;
    writeFileSync(
      file,
      JSON.stringify({ enforce, url, credential, workspace, environment }),
    );
    expect(() => readHookConnection(file)).toThrow();
    expect(readHookConnection(file, true)).toEqual(config);
  });

  test("local settings stay local when there is no control plane", () => {
    const { file, root } = installed();
    const local = { decide: "local", enforce: "watch" };
    const manifest = stringify({ connect: local });
    writeFileSync(join(root, "nodrail.yaml"), manifest);
    writeFileSync(
      join(root, "nodrail.lock.yaml"),
      stringify({
        manifest: { sha256: sha256(manifest) },
        effective: { sha256: sha256(source) },
        workspace: { sha256: "4".repeat(64) },
      }),
    );
    writeFileSync(file, JSON.stringify(local));
    expect(readHookConnection(file)).toEqual(local);
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
      if (status === 304) expect(result).toContain(reason);
      else
        expect(result).toMatchObject({
          warning: expect.stringContaining(reason),
        });
    },
  );

  test("uses the enrolled credential only for its origin and project", async () => {
    const projectId = "63ae0d29-ab7d-4487-83d0-1780ba28441a";
    const token = `ndr_000000000000_${"A".repeat(43)}`;
    const { file, home, config, env } = installed("on", projectId);
    const binding = {
      projectId,
      workspace: config.workspace,
      environment: config.environment,
    };
    const settings = readHookConnection(file);
    if (settings.decide !== "cloud")
      throw new Error("Expected a connected fixture.");
    await writeHostCredential(home, {
      ...binding,
      origin: "https://another.example",
      credential: `ndr_000000000001_${"B".repeat(43)}`,
      installationId: projectId,
    });
    const requests: Request[] = [];
    const send: typeof fetch = async (url, init) => {
      requests.push(new Request(url, init));
      return Response.json({
        source: { text: source, digest: config.policy_digest },
      });
    };
    expect(
      await loadHookPolicy(file, settings, env, { home, fetch: send }),
    ).toContain("isn't enrolled");
    expect(requests).toEqual([]);
    await writeHostCredential(home, {
      ...binding,
      origin: config.url,
      credential: token,
      installationId: projectId,
    });
    expect(
      await loadHookPolicy(file, settings, env, { home, fetch: send }),
    ).toMatchObject({
      digest: config.policy_digest,
    });
    expect(requests[0]?.headers.get("authorization")).toBe(`Bearer ${token}`);
    expect(requests[0]?.redirect).toBe("error");
  });

  test("records cold and warm outages without storing credentials", async () => {
    const setup = installed();
    const { file, home, config, env } = setup;
    const offline = async () => {
      throw new Error("offline");
    };
    const check = () =>
      readFileSync(
        join(spoolFolder(home, file, "policies"), POLICY_CHECK_FILE),
        "utf8",
      );
    const invoke = (fetch: typeof globalThis.fetch) =>
      hookCommand(
        { values: { connect: file }, now: new Date(), paths: [] },
        {
          home,
          env,
          fetch,
          readStdin: async () =>
            JSON.stringify({
              tool_name: "Bash",
              tool_input: { command: "ls" },
            }),
          write: () => {},
          writeError: () => {},
        },
        async () => null,
      );
    await invoke(offline);
    expect(JSON.parse(check())).toMatchObject({ state: "unavailable" });
    await invoke(async () =>
      Response.json({ source: { text: source, digest: config.policy_digest } }),
    );
    expect(JSON.parse(check())).toMatchObject({ state: "live" });
    await invoke(offline);
    expect(JSON.parse(check())).toMatchObject({ state: "cached" });
    expect(check()).not.toContain(env.HOST_CREDENTIAL);
  });

  test("only uses a 304 after sending a validator from a verified response", async () => {
    const setup = installed();
    const { config } = setup;
    const pull = pullFrom(setup);
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

  test("honors an explicit takeover denial in a policy response", async () => {
    const { file, home, config, env } = installed();
    const settings = readHookConnection(file);
    const reason = "Project new-owner now owns this environment's policy";
    const deny = await loadHookPolicy(file, settings, env, {
      home,
      fetch: async () =>
        Response.json({
          source: { text: source, digest: config.policy_digest },
          denial_reason: reason,
        }),
    });
    expect(deny).toContain(reason);
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
