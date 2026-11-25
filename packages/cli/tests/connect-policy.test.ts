// With decide: cloud, plan compares what is live with the lock, and apply
// publishes it.
import { describe, expect, test } from "vitest";
import { EFFECTIVE_FILE } from "../src/setup/claude-code.ts";
import { livePolicy, publishPolicy } from "../src/setup/connect-policy.ts";

const ID = "6f1c2a8e-5b7d-4e0f-9a6c-1d2e3f405162";
const LOCK = "a".repeat(64);
const EFFECTIVE = "b".repeat(64);
const YAML = "- rule: Read\n  command: { prefix: ls }\n  effect: allow\n";

const plan = (over: Record<string, unknown> = {}) => ({
  connect: {
    workspace: "acme",
    environment: "development",
    decide: "cloud" as const,
    enforce: "on" as const,
    credential: { fromEnv: "NODRAIL_CREDENTIAL" },
  },
  projectId: ID as string | null,
  revision: { workspace: LOCK as string | null, policy: EFFECTIVE },
  files: [{ path: EFFECTIVE_FILE, content: Buffer.from(YAML), why: "" }],
  ...over,
});

type Live = {
  policy_revision: number;
  managed: {
    project_id: string;
    revision: string;
    policy_revision: string | null;
  } | null;
};

function cloud(
  live: Live,
  options: {
    workspace?: string;
    rulesWrite?: boolean;
    issues?: unknown[];
    sourceDigest?: string | null;
  } = {},
) {
  const sent: { method: string; path: string; body: unknown }[] = [];
  const fetcher = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const body =
      typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    sent.push({
      method: init.method ?? "GET",
      path: url.pathname + url.search,
      body,
    });
    const json = (value: unknown) =>
      new Response(JSON.stringify(value), { status: 200 });
    if (url.pathname === "/api/v1/me")
      return json({
        workspace: { id: "w", name: "Acme", slug: options.workspace ?? "acme" },
        can: {
          read: true,
          decide: false,
          rules_write: options.rulesWrite ?? true,
        },
      });
    if (url.pathname === "/api/v1/rules/live")
      return json({
        environment: "development",
        published_at: "2026-11-22T10:00:00.000Z",
        published_by: "Ada",
        source_digest:
          options.sourceDigest === undefined
            ? (live.managed?.policy_revision ?? null)
            : options.sourceDigest,
        ...live,
      });
    if (url.pathname === "/api/v1/rules/preview")
      return json({
        issues: options.issues ?? [],
        warnings: [],
        policy_revision: live.policy_revision,
        file_digest: "digest",
        added: ["Read"],
        changed: [],
        removed: [],
        unchanged: 0,
      });
    if (url.pathname === "/api/v1/rules/publish")
      return json({
        policy_revision: live.policy_revision + 1,
        added: 1,
        changed: 0,
        removed: 0,
        closed_requests: 0,
      });
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  return {
    sent,
    io: {
      env: { NODRAIL_TOKEN: "ndp_person" },
      home: "/nonexistent",
      fetch: fetcher,
    },
  };
}

const mine = { project_id: ID, revision: LOCK, policy_revision: EFFECTIVE };

describe("the live policy against the lock", () => {
  test("decide: local asks nothing", async () => {
    const { sent, io } = cloud({ policy_revision: 0, managed: null });
    const state = await livePolicy(
      plan({ connect: { ...plan().connect, decide: "local" } }),
      io,
    );
    expect(state).toEqual({ checks: [], publish: null });
    expect(sent).toEqual([]);
  });

  test("without an id there's nothing to tie the policy to", async () => {
    const { io } = cloud({ policy_revision: 0, managed: null });
    const [check] = (await livePolicy(plan({ projectId: null }), io)).checks;
    expect(check).toMatchObject({ ok: false });
    expect(check!.detail).toContain("add `id: <uuid>` to nodrail.yaml");
  });

  test("without the person's token it's unchecked, not failed", async () => {
    const { io } = cloud({ policy_revision: 0, managed: null });
    const [check] = (await livePolicy(plan(), { ...io, env: {} })).checks;
    expect(check).toMatchObject({ ok: true, unverified: true });
    expect(check!.detail).toContain(
      "nodrail login --url https://app.nodrail.com",
    );
  });

  test("a token for another workspace fails", async () => {
    const { io } = cloud(
      { policy_revision: 0, managed: null },
      { workspace: "other" },
    );
    const [check] = (await livePolicy(plan(), io)).checks;
    expect(check).toMatchObject({ ok: false });
    expect(check!.detail).toContain("workspace other, not acme");
  });

  test("nothing live yet: apply publishes", async () => {
    const { sent, io } = cloud({ policy_revision: 0, managed: null });
    const state = await livePolicy(plan(), io);
    expect(state.checks[0]).toMatchObject({ ok: true });
    expect(state.checks[0]!.detail).toBe(
      "apply publishes lock aaaaaaaaaaaa to development: 1 added, 0 changed, 0 removed",
    );
    expect(state.publish?.managed).toEqual(mine);
    expect(
      sent.every(
        (call) =>
          call.method === "GET" ||
          call.path.startsWith("/api/v1/rules/preview"),
      ),
    ).toBe(true);
    expect(
      sent.find((call) => call.path.startsWith("/api/v1/rules/live"))?.path,
    ).toBe("/api/v1/rules/live?environment=development");
  });

  test("in sync: nothing to publish", async () => {
    const { io } = cloud({ policy_revision: 4, managed: mine });
    const state = await livePolicy(plan(), io);
    expect(state.publish).toBeNull();
    expect(state.checks[0]!.detail).toBe(
      "in sync: development serves lock aaaaaaaaaaaa (v4, Ada)",
    );
  });

  test("this project's older lock: apply publishes the new one", async () => {
    const { io } = cloud({
      policy_revision: 4,
      managed: { ...mine, revision: "c".repeat(64) },
    });
    const state = await livePolicy(plan(), io);
    expect(state.checks[0]).toMatchObject({ ok: true });
    expect(state.publish).not.toBeNull();
  });

  test("rules changed in Nodrail are drift: refused, unless --replace-live", async () => {
    const { io } = cloud({ policy_revision: 5, managed: null });
    const refused = await livePolicy(plan(), io);
    expect(refused.checks[0]).toMatchObject({ ok: false });
    expect(refused.checks[0]!.detail).toContain(
      "were changed in Nodrail, not published from this repo",
    );
    expect(refused.publish).toBeNull();
    const taken = await livePolicy(plan(), io, { replaceLive: true });
    expect(taken.checks[0]).toMatchObject({ ok: true });
    expect(taken.checks[0]!.detail).toContain(
      "replacing rules changed elsewhere",
    );
    expect(taken.publish).not.toBeNull();
  });

  test("another project's rules are drift too", async () => {
    const { io } = cloud({
      policy_revision: 2,
      managed: { ...mine, project_id: "11111111-1111-4111-8111-111111111111" },
    });
    const [check] = (await livePolicy(plan(), io)).checks;
    expect(check).toMatchObject({ ok: false });
    expect(check!.detail).toContain("come from another project");
  });

  test("a policy the environment would refuse fails with its reason", async () => {
    const { io } = cloud(
      { policy_revision: 0, managed: null },
      { issues: [{ line: 3, column: 1, message: "unknown agent ghost" }] },
    );
    const [check] = (await livePolicy(plan(), io)).checks;
    expect(check).toMatchObject({ ok: false });
    expect(check!.detail).toContain("unknown agent ghost (line 3)");
  });

  test("a previously managed version with no source is republished", async () => {
    const { io } = cloud(
      { policy_revision: 4, managed: mine },
      { sourceDigest: null },
    );
    const result = await livePolicy(plan(), io);
    expect(result.publish?.managed).toEqual(mine);
    expect(result.checks[0]!.detail).toContain("apply publishes lock");
  });

  test("a token that can't publish fails only when there's something to publish", async () => {
    const behind = cloud(
      { policy_revision: 0, managed: null },
      { rulesWrite: false },
    );
    expect((await livePolicy(plan(), behind.io)).checks[0]).toMatchObject({
      ok: false,
      detail: "your token can't publish (it needs rules:write)",
    });
    const synced = cloud(
      { policy_revision: 4, managed: mine },
      { rulesWrite: false },
    );
    expect((await livePolicy(plan(), synced.io)).checks[0]).toMatchObject({
      ok: true,
    });
  });

  test("publishing sends what plan previewed, with the project and lock", async () => {
    const { sent, io } = cloud({ policy_revision: 0, managed: null });
    const state = await livePolicy(plan(), io);
    await publishPolicy(state.publish!);
    const publish = sent.find((call) =>
      call.path.startsWith("/api/v1/rules/publish"),
    );
    expect(publish?.path).toBe("/api/v1/rules/publish?environment=development");
    expect(publish?.body).toEqual({
      yaml: YAML,
      policy_revision: 0,
      file_digest: "digest",
      managed: mine,
    });
  });
});
