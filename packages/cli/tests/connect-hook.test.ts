// Connected mode end to end (PR 3, R383): plan and apply against a stand-in
// Nodrail publish the locked policy and install the connected hook; the
// hook keeps the local guards and asks Nodrail for everything else.
import { describe, expect, test } from "vitest";
import { fakeNodrail } from "../../client/tests/support/fake-nodrail.ts";
import { CONNECT_FILE } from "../src/setup/claude-code.ts";
import { locked, RESOURCES } from "./support/setup-project.ts";

const ID = "6f1c2a8e-5b7d-4e0f-9a6c-1d2e3f405162";
const URL_ = "https://nodrail.test";
const CREDENTIAL = "ndr_000000000000_" + "A".repeat(43);

/** Nodrail as plan, apply and the hook meet it. */
function standIn(
  answer?: (descriptor: { tool?: unknown; resource?: unknown }) => string,
) {
  const runtime = fakeNodrail(answer as never);
  const published: Record<string, unknown>[] = [];
  let live: { policy_revision: number; managed: unknown } = {
    policy_revision: 0,
    managed: null,
  };
  const fetcher = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const json = (value: unknown) =>
      new Response(JSON.stringify(value), { status: 200 });
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    switch (url.pathname) {
      case "/api/v1/runtime/identity":
        return json({
          workspace: "acme",
          environment: "development",
          agent: "claude-luca",
        });
      case "/api/v1/me":
        return json({
          workspace: { id: "w", name: "Acme", slug: "acme" },
          can: { read: true, decide: false, rules_write: true },
        });
      case "/api/v1/rules/live":
        return json({
          environment: "development",
          published_at: null,
          published_by: null,
          ...live,
        });
      case "/api/v1/rules/preview":
        return json({
          issues: [],
          warnings: [],
          policy_revision: live.policy_revision,
          file_digest: "digest",
          added: ["a"],
          changed: [],
          removed: [],
          unchanged: 0,
        });
      case "/api/v1/rules/publish":
        published.push(body);
        live = {
          policy_revision: live.policy_revision + 1,
          managed: body.managed,
        };
        return json({
          policy_revision: live.policy_revision,
          added: 1,
          changed: 0,
          removed: 0,
          closed_requests: 0,
        });
      default:
        return runtime.fetch(String(input) as never, init);
    }
  }) as unknown as typeof fetch;
  return { fetcher, published, runtime };
}

const CONNECT = `id: ${ID}
connect:
  url: ${URL_}
  workspace: acme
  environment: development
  decide: cloud
  credential: { fromEnv: NODRAIL_CREDENTIAL }
`;

async function connected(answer?: Parameters<typeof standIn>[0]) {
  const cloud = standIn(answer);
  const p = await locked(
    { ...RESOURCES, "nodrail.yaml": `${RESOURCES["nodrail.yaml"]}${CONNECT}` },
    undefined,
    cloud.fetcher,
  );
  p.env.NODRAIL_CREDENTIAL = CREDENTIAL;
  p.env.NODRAIL_URL = URL_;
  p.env.NODRAIL_TOKEN = "ndp_person";
  p.env.HOME = p.home;
  return { p, cloud };
}

const call = (cwd: string, tool: string, input: Record<string, unknown>) =>
  JSON.stringify({
    hook_event_name: "PreToolUse",
    session_id: "s",
    tool_use_id: `t-${Math.random()}`,
    cwd,
    tool_name: tool,
    tool_input: input,
  });

describe("connected mode, end to end", () => {
  test("apply publishes the lock and installs the connected hook", async () => {
    const { p, cloud } = await connected();
    const plan = await p.run("plan");
    expect(plan.out).toContain(
      "credential NODRAIL_CREDENTIAL: accepted: agent claude-luca in acme/development",
    );
    expect(plan.out).toContain("apply publishes lock");
    expect(plan.code).toBe(0);

    const apply = await p.run("apply", "--yes");
    expect(apply.err).toBe("");
    expect(apply.code).toBe(0);
    expect(cloud.published).toHaveLength(1);
    expect(cloud.published[0]!.managed).toMatchObject({ project_id: ID });

    const settings = JSON.parse(p.read(".claude/settings.json"));
    const pre = settings.hooks.PreToolUse[0].hooks[0];
    expect(pre.command).toMatch(
      /^nodrail connect hook "\$CLAUDE_PROJECT_DIR\/\.nodrail\/connect\.json" --protect-list /,
    );
    expect(pre).toMatchObject({ onFailure: "block", timeout: 30 });
    for (const event of [
      "SubagentStart",
      "SubagentStop",
      "PostToolUse",
      "PostToolUseFailure",
    ])
      expect(settings.hooks[event]?.[0]?.hooks[0]?.command).toBe(pre.command);
    // References only: the credential never reaches a file.
    expect(JSON.parse(p.read(CONNECT_FILE))).toEqual({
      url: URL_,
      workspace: "acme",
      environment: "development",
      enforce: "on",
      credential: { fromEnv: "NODRAIL_CREDENTIAL" },
    });
    expect(p.read(CONNECT_FILE)).not.toContain("ndr_");

    // In sync now: plan has nothing to publish.
    expect((await p.run("plan")).out).toContain(
      "in sync: development runs lock",
    );
    const status = await p.run("status");
    expect(status.out).not.toContain("policy hook is gone");
    expect(status.out).not.toContain("no longer has its protect list");
  });

  test("the hook asks Nodrail, and keeps the local guards first", async () => {
    const { p, cloud } = await connected((descriptor) =>
      JSON.stringify(descriptor.resource).includes("rm -rf")
        ? "DENIED"
        : "READY",
    );
    expect((await p.run("apply", "--yes")).code).toBe(0);
    const hook = (stdin: string) =>
      p.runWith(
        { stdin },
        "connect",
        "hook",
        `${p.cwd}/${CONNECT_FILE}`,
        "--protect-list",
        `${p.cwd}/.nodrail/protected.txt`,
      );

    const allowed = await hook(call(p.cwd, "Bash", { command: "ls" }));
    expect(allowed.code).toBe(0);
    expect(allowed.out).not.toContain('"deny"');

    const denied = await hook(call(p.cwd, "Bash", { command: "rm -rf build" }));
    expect(denied.out).toContain('"permissionDecision":"deny"');

    const before = cloud.runtime.seen().length;
    const guarded = await hook(
      call(p.cwd, "Write", {
        file_path: `${p.cwd}/.claude/settings.json`,
        content: "{}",
      }),
    );
    expect(guarded.out).toContain('"permissionDecision":"deny"');
    // Refused here: Nodrail never even saw it.
    expect(cloud.runtime.seen().length).toBe(before);
  });

  test("apply refuses when the live policy can't be checked", async () => {
    const { p } = await connected();
    delete p.env.NODRAIL_TOKEN;
    const plan = await p.run("plan");
    expect(plan.code).toBe(0);
    expect(plan.out).toContain("? live policy: not checked: no token");
    const apply = await p.run("apply", "--yes");
    expect(apply.code).toBe(1);
    expect(apply.out).toContain(
      "apply needs it checked before it installs the hook",
    );
    expect(() => p.read(".claude/settings.json")).toThrow();
  });

  test("without its credential the hook blocks a call, and never a step", async () => {
    const { p } = await connected();
    expect((await p.run("apply", "--yes")).code).toBe(0);
    delete p.env.NODRAIL_CREDENTIAL;
    const run = (stdin: string) =>
      p.runWith(
        { stdin },
        "connect",
        "hook",
        `${p.cwd}/${CONNECT_FILE}`,
        "--protect-list",
        `${p.cwd}/.nodrail/protected.txt`,
      );
    const blocked = await run(call(p.cwd, "Bash", { command: "ls" }));
    expect(blocked.code).toBe(2);
    expect(blocked.err).toContain("NODRAIL_CREDENTIAL isn't set");
    const step = await run(
      JSON.stringify({
        hook_event_name: "SubagentStart",
        session_id: "s",
        agent_id: "a",
        agent_type: "qa",
        cwd: p.cwd,
      }),
    );
    expect(step.code).toBe(0);
  });
});
