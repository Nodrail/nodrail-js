import { describe, expect, test, vi } from "vitest";
import { accessChecks } from "../src/hook-access.ts";
import type { HookConnection } from "../src/hook-connection.ts";

const cloud = {
  decide: "cloud",
  enforce: "on",
  url: "https://nodrail.example",
  lock: "../nodrail.lock.yaml",
  workspace: "test",
  environment: "dev",
  project_id: "63ae0d29-ab7d-4487-83d0-1780ba28441a",
  policy_digest: "a".repeat(64),
  workspace_revision: "b".repeat(64),
} satisfies HookConnection;

const reply = {
  agent: "worker",
  paused: false,
  workspace: cloud.workspace,
  environment: cloud.environment,
  project_id: cloud.project_id,
};

function check(send: typeof fetch) {
  return accessChecks(
    {
      url: cloud.url,
      token: "fixture",
      workspaceRevision: cloud.workspace_revision,
      fetch: send,
    },
    cloud,
    "entry",
  );
}

describe("connected access checks", () => {
  test("only a connected hook requests access", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const config = {
      url: cloud.url,
      token: "fixture",
      workspaceRevision: cloud.workspace_revision,
      fetch,
    };
    await expect(accessChecks(null, cloud)("{}")).resolves.toEqual({});
    await expect(accessChecks(config, null)("{}")).resolves.toEqual({});
    await expect(
      accessChecks(config, { decide: "local", enforce: "on" })("{}"),
    ).resolves.toEqual({});
    expect(fetch).not.toHaveBeenCalled();
  });

  test.each([
    ["invalid JSON", "{", "entry"],
    ["unnamed delegate", '{"agent_id":"step"}', null],
    ["named delegate", '{"agent_id":"step","agent_type":"Worker"}', "worker"],
  ])("resolves the caller for %s", async (_label, stdin, candidate) => {
    const fetch: typeof globalThis.fetch = async (url, init) => {
      const request = new Request(url, init);
      const query = new URL(request.url).searchParams;
      expect(query.get("agent")).toBe(candidate);
      expect(query.get("call")).toMatch(/^claude-code:[a-f0-9-]{36}$/);
      expect(query.get("policy_digest")).toBe(cloud.policy_digest);
      expect(request.headers.get("authorization")).toBe("Bearer fixture");
      expect(request.redirect).toBe("error");
      return Response.json({
        ...reply,
        project_id: null,
        admission_id: "receipt",
      });
    };
    expect(await check(fetch)(stdin)).toEqual({
      caller: "worker",
      admission: {
        id: "receipt",
        call: expect.stringMatching(/^claude-code:/),
      },
    });
  });

  test.each([
    { workspace: "other" },
    { environment: "prod" },
    { project_id: "9bfc0cd6-4920-4a33-9102-f940317513cf" },
  ])("rejects a response bound to %o", async (binding) => {
    expect(
      await check(async () => Response.json({ ...reply, ...binding }))("{}"),
    ).toEqual({
      accessRefusal: expect.stringContaining(
        "different project or environment",
      ),
    });
  });

  test.each([
    [undefined, undefined, ["worker"], "access for worker is paused."],
    [[], undefined, ["worker"], "access for worker is paused."],
    [["other"], "project paused", ["other"], "project paused"],
  ] as const)(
    "reports a pause with agent list %o",
    async (agents, reason, expected, message) => {
      const fetch = async () =>
        Response.json({
          ...reply,
          paused: true,
          paused_agents: agents,
          reason,
        });
      expect(await check(fetch)("{}")).toEqual({
        caller: "worker",
        pausedAgents: expected,
        accessRefusal: `Nodrail: ${message}`,
      });
    },
  );

  test.each([
    [
      409,
      { error: { code: "RULE_CHANGED", message: "Run nodrail apply" } },
      "Run nodrail apply",
    ],
    [404, { error: {} }, "fresh agent access status is unavailable"],
    [200, { agent: "" }, "fresh agent access status is unavailable"],
  ] as const)(
    "fails closed for an access response with status %i",
    async (status, body, message) => {
      expect(
        await check(async () => Response.json(body, { status }))("{}"),
      ).toEqual({
        accessRefusal: expect.stringContaining(message),
      });
    },
  );
});
