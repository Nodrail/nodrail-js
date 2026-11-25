// Connected setup publishes the locked policy and installs a host hook.
// The hook verifies the policy and judges the call with its local guards.
import { describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readRun, runFile } from "@nodrail/policy-engine/ledger";
import { spoolFolder } from "@nodrail/policy-engine/command-line";
import { CONNECT_FILE } from "../src/setup/connect.ts";
import {
  codexTools,
  copilotTools,
  locked,
  RESOURCES,
  windows,
} from "./support/setup-project.ts";

const ID = "6f1c2a8e-5b7d-4e0f-9a6c-1d2e3f405162";
const URL_ = "https://nodrail.test";
const CREDENTIAL = "ndr_000000000000_" + "A".repeat(43);

/** Nodrail as plan, apply and the hook meet it. */
function standIn() {
  const requests: { path: string; headers: Headers; body?: unknown }[] = [];
  const remote = {
    offline: false,
    status: 200,
    different: false,
    denial: null as string | null,
    paused: false,
    takeover: false,
  };
  let source: { digest: string; text: string } | undefined;
  const published: Record<string, unknown>[] = [];
  const previews: Record<string, unknown>[] = [];
  let live: { policy_revision: number; managed: unknown } = {
    policy_revision: 0,
    managed: null,
  };
  const policy = (headers: Headers) => {
    if (remote.offline) throw new Error("network unavailable");
    if (remote.takeover)
      return Response.json(
        {
          error: {
            code: "RULE_CHANGED",
            message: "Project New owner now owns this environment's policy.",
          },
        },
        { status: 409 },
      );
    if (remote.status !== 200)
      return new Response(null, { status: remote.status });
    if (remote.denial)
      return Response.json({ source: null, denial_reason: remote.denial });
    const etag = remote.different ? '"version-2"' : '"version-1"';
    if (
      headers.get("if-none-match") === "*" ||
      headers.get("if-none-match") === etag
    )
      return new Response(null, { status: 304 });
    return Response.json(
      {
        source: remote.different ? { ...source, text: "changed" } : source,
      },
      { headers: { etag } },
    );
  };
  const access = (url: URL) => {
    if (remote.offline) throw new Error("network unavailable");
    return Response.json({
      workspace: "acme",
      environment: "development",
      project_id: null,
      agent: url.searchParams.get("agent") ?? "claude-luca",
      paused: remote.paused,
    });
  };
  let intended: unknown = null;
  const applyProject = (
    body: Record<string, unknown> & {
      yaml: string;
      intended: {
        project_id: string;
        revision: string;
        policy_revision: string;
      };
    },
  ) => {
    published.push(body);
    source = {
      text: body.yaml,
      digest: createHash("sha256").update(body.yaml).digest("hex"),
    };
    const { project_id, revision, policy_revision } = body.intended;
    intended = body.intended;
    live = {
      policy_revision: live.policy_revision + 1,
      managed: { project_id, revision, policy_revision },
    };
    return Response.json({
      published: {
        policy_revision: live.policy_revision,
        added: 1,
        changed: 0,
        removed: 0,
      },
      enrollment: body.machine
        ? {
            installation_id: "86e4d609-e814-484e-adb5-5e0de4761784",
            credential: CREDENTIAL,
          }
        : null,
    });
  };
  const fetcher = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const json = (value: unknown) =>
      new Response(JSON.stringify(value), { status: 200 });
    const body =
      typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({
      path: url.pathname,
      headers: new Headers(init.headers),
      body,
    });
    switch (url.pathname) {
      case "/api/v1/runtime/inventory":
        return json({ recorded: true });
      case "/api/v1/runtime/policy":
        return policy(new Headers(init.headers));
      case "/api/v1/runtime/access":
        return access(url);
      case "/api/v1/runtime/identity":
        return json({
          workspace: "acme",
          environment: "development",
          agent: "claude-luca",
        });
      case "/api/v1/verifiers":
        return json({ items: [{ name: "github-actions", revokedAt: null }] });
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
          source_digest: source?.digest ?? null,
        });
      case "/api/v1/rules/preview":
        previews.push(body);
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
      case "/api/v1/workspace-revisions":
        return json({ revision: intended });
      case "/api/v1/projects/apply":
        return applyProject(body);
      default:
        throw new Error(`unexpected request: ${url.pathname}`);
    }
  }) as unknown as typeof fetch;
  return { fetcher, published, previews, requests, remote };
}

const CONNECT = `id: ${ID}
connect:
  url: ${URL_}
  workspace: acme
  environment: development
  decide: cloud
  credential: { fromEnv: NODRAIL_CREDENTIAL }
`;

async function connected({
  watch = false,
  runtime = "claude-code",
  rules = RESOURCES["policies/base.yaml"],
  connection = CONNECT,
} = {}) {
  const cloud = standIn();
  const p = await locked(
    {
      ...RESOURCES,
      "policies/base.yaml": rules,
      "nodrail.yaml": `${RESOURCES["nodrail.yaml"].replace("runtime: claude-code", `runtime: ${runtime}`)}${connection}${watch ? "  enforce: watch\n" : ""}`,
    },
    runtime === "codex"
      ? codexTools()
      : runtime === "copilot"
        ? copilotTools()
        : undefined,
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

const hook =
  (p: Awaited<ReturnType<typeof connected>>["p"], ...flags: string[]) =>
  (stdin: string) =>
    p.runWith(
      { stdin, self: ["--eval", ""] },
      "policy",
      "hook",
      join(p.cwd, ".nodrail/effective.yaml"),
      "--connect",
      join(p.cwd, CONNECT_FILE),
      "--protect-list",
      join(p.cwd, ".nodrail/protected.txt"),
      ...flags,
    );

async function applied(options?: Parameters<typeof connected>[0]) {
  const project = await connected(options);
  const result = await project.p.run("apply", "--yes");
  expect(result.code, [result.out, result.err].filter(Boolean).join("\n")).toBe(
    0,
  );
  return project;
}

const readSource = (cwd: string) =>
  call(cwd, "Read", { file_path: "src/a.ts" });

async function warmCache() {
  const { p, cloud } = await applied();
  const run = hook(p);
  const read = readSource(p.cwd);
  expect((await run(read)).out).toBe("");
  return { p, cloud, read, run };
}

describe("connected mode, end to end", () => {
  test("an enrolled machine runs a tool call with a mixed-case origin and explicit default port", async () => {
    const { p, cloud } = await applied({
      connection: CONNECT.replace(URL_, "https://Nodrail.Test:443").replace(
        /^  credential:.*\n/m,
        "",
      ),
    });
    delete p.env.NODRAIL_CREDENTIAL;
    const result = await hook(p)(readSource(p.cwd));
    expect(result.code).toBe(0);
    expect(result.err).toBe("");
    expect(result.out).toBe("");
    expect(
      cloud.requests
        .find(({ path }) => path === "/api/v1/runtime/policy")
        ?.headers.get("authorization"),
    ).toBe(`Bearer ${CREDENTIAL}`);
  });

  test("a takeover explains the denial even when this host has a verified cached policy", async () => {
    const { cloud, read, run } = await warmCache();
    cloud.remote.denial =
      "live policy is now owned by project 86e4d609-e814-484e-adb5-5e0de4761784";
    const result = await run(read);
    expect(result.out).toContain(cloud.remote.denial);
    expect(result.out).toContain('"permissionDecision":"deny"');
  });

  test("first apply sends locked evidence and contract pins through preview and publish", async () => {
    const { cloud } = await applied({ rules: verifiedRules });
    expect(cloud.published[0]?.intended).toMatchObject({
      contracts: {
        bindings: [{ target: "evidence:ci-tests", surface: "evidence" }],
      },
      evidence: {
        bindings: [{ evidence: "ci-tests", verifiers: ["github-actions"] }],
        requirements: ["tested", "tested-args"].map((gate) => ({
          gate,
          index: 0,
          evidence: "ci-tests",
          authority: "externally-verified",
        })),
      },
    });
    expect(cloud.previews[0]?.intended).toEqual(cloud.published[0]?.intended);
  });

  test("apply publishes the lock and installs the connected hook", async () => {
    const { p, cloud } = await connected();
    const legacy =
      'nodrail connect hook "$CLAUDE_PROJECT_DIR/.nodrail/connect.json"';
    p.write(
      ".claude/settings.json",
      JSON.stringify({
        hooks: {
          PreToolUse: [{ hooks: [{ type: "command", command: legacy }] }],
        },
      }),
    );
    const plan = await p.run("plan");
    expect(plan.out).toContain("Apply publishes policy v1: 1 added");
    expect(plan.code).toBe(0);
    const details = await p.run("plan", "--details");
    expect(details.code).toBe(0);
    expect(details.out).toContain(
      "credential NODRAIL_CREDENTIAL: accepted: agent claude-luca in acme/development",
    );
    expect(details.out).toContain("Legacy Nodrail setup detected");
    expect(details.out).toContain("The host decides using the locked policy");

    const apply = await p.run("apply", "--yes");
    expect(apply.err).toBe("");
    expect(apply.code).toBe(0);
    expect(cloud.published).toHaveLength(1);
    expect(cloud.published[0]!.intended).toMatchObject({ project_id: ID });

    const settings = JSON.parse(p.read(".claude/settings.json"));
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    const pre = settings.hooks.PreToolUse[0].hooks[0];
    expect(pre.command).toMatch(
      /^nodrail policy hook .* --connect "\$CLAUDE_PROJECT_DIR\/\.nodrail\/connect\.json"/,
    );
    expect(pre).toMatchObject({ onFailure: "block" });
    for (const event of [
      "SubagentStart",
      "SubagentStop",
      "PostToolUse",
      "PostToolUseFailure",
    ])
      expect(settings.hooks[event]?.[0]?.hooks[0]?.command).toBe(pre.command);
    // References only: the credential never reaches a file.
    expect(JSON.parse(p.read(CONNECT_FILE))).toMatchObject({
      decide: "cloud",
      url: URL_,
      workspace: "acme",
      environment: "development",
      enforce: "on",
      policy_digest: (
        cloud.published[0]!.intended as { policy_revision: string }
      ).policy_revision,
      credential: { fromEnv: "NODRAIL_CREDENTIAL" },
    });
    expect(p.read(CONNECT_FILE)).not.toContain("ndr_");

    // In sync now: plan has nothing to publish.
    expect((await p.run("plan")).out).toContain(
      "In sync. development policy v1 serves lock",
    );
    const status = await p.run("status");
    expect(status.out).not.toContain("policy hook is gone");
    expect(status.out).not.toContain("no longer has its protect list");
  });

  test("an installed legacy hook delegates before reapply and verifies its destination", async () => {
    const { p, cloud } = await applied();
    const file = join(p.cwd, CONNECT_FILE);
    const { url, workspace, environment, enforce, credential } = JSON.parse(
      p.read(CONNECT_FILE),
    );
    const legacy = { url, workspace, environment, enforce, credential };
    p.write(CONNECT_FILE, JSON.stringify(legacy));
    const run = (stdin: string) =>
      p.runWith(
        { stdin, self: ["--eval", ""] },
        "connect",
        "hook",
        file,
        "--protect-list",
        join(p.cwd, ".nodrail/protected.txt"),
      );
    expect(
      await run(call(p.cwd, "Read", { file_path: "src/a.ts" })),
    ).toMatchObject({ code: 0, out: "", err: "" });
    expect((await run(call(p.cwd, "Bash", { command: "ls" }))).out).toContain(
      "no rule covers",
    );
    cloud.requests.length = 0;
    p.write(
      CONNECT_FILE,
      JSON.stringify({ ...legacy, url: "https://other.example" }),
    );
    expect(
      (await run(call(p.cwd, "Read", { file_path: "src/a.ts" }))).out,
    ).toContain("repository lock differs");
    expect(cloud.requests).toEqual([]);
  });

  test.skipIf(windows).each(["codex", "copilot"])(
    "installs the connected engine hook for %s",
    async (runtime) => {
      const { p } = await connected({ runtime });
      const apply = await p.run("apply", "--yes");
      expect(apply.code).toBe(0);
      if (runtime === "codex")
        expect(apply.out).toContain("Codex won't run the policy yet");
      const file =
        runtime === "codex"
          ? ".codex/hooks.json"
          : ".github/hooks/nodrail.json";
      const hooks = p.read(file);
      expect(hooks).toContain("nodrail policy hook");
      expect(hooks).toContain("--connect");
      expect(hooks).toContain(`--host ${runtime}`);
      expect(hooks).toMatch(/postToolUse/i);
      const input =
        runtime === "codex"
          ? call(p.cwd, "Bash", { command: "ls" })
          : JSON.stringify({
              cwd: p.cwd,
              sessionId: "s",
              toolCallId: "t",
              toolName: "bash",
              toolArgs: { command: "ls" },
            });
      const result = await hook(p, "--host", runtime)(input);
      expect(result.code).toBe(0);
      expect(result.out).toContain('"permissionDecision":"deny"');
      expect(result.out).toContain("no rule covers");
    },
  );

  test("revalidates cached policy and requires fresh access", async () => {
    const { p, cloud } = await applied();
    const run = hook(p);
    const read = readSource(p.cwd);
    const policyState = async () => {
      const status = await p.run("status", "--json");
      return {
        code: status.code,
        remote: JSON.parse(status.out).policy.remote,
      };
    };
    expect(await policyState()).toMatchObject({
      code: 1,
      remote: { state: "unchecked" },
    });
    const checkOffline = async () => {
      cloud.remote.offline = true;
      expect((await run(read)).out).toContain(
        "fresh agent access status is unavailable",
      );
    };
    await checkOffline();
    expect(await policyState()).toMatchObject({
      code: 1,
      remote: { state: "cached", detail: null },
    });
    cloud.remote.offline = false;
    cloud.requests.length = 0;
    const shell = call(p.cwd, "Bash", { command: "ls" });
    expect(await run(read)).toMatchObject({ code: 0, out: "" });
    expect(await policyState()).toMatchObject({
      code: 0,
      remote: { state: "live", detail: null },
    });
    expect(await run(shell)).toMatchObject({
      out: expect.stringContaining("no rule covers"),
    });

    const pulls = cloud.requests.filter(
      ({ path }) => path === "/api/v1/runtime/policy",
    );
    expect(pulls[0]!.headers.get("authorization")).toBe(`Bearer ${CREDENTIAL}`);
    expect(pulls[0]!.headers.has("if-none-match")).toBe(false);
    expect(pulls[1]!.headers.get("if-none-match")).toBe('"version-1"');
    expect(
      cloud.requests.some(({ path }) => path.includes("/runtime/actions")),
    ).toBe(false);

    await checkOffline();
    expect(await policyState()).toMatchObject({
      code: 1,
      remote: { state: "cached", detail: null },
    });
    const lock = p.read("nodrail.lock.yaml");
    p.write(
      "nodrail.lock.yaml",
      lock.replace(
        JSON.parse(p.read(CONNECT_FILE)).policy_digest,
        "a".repeat(64),
      ),
    );
    expect((await run(read)).out).toContain(
      "repository lock differs from the applied policy",
    );
  });

  test("observe sends connected Inventory without a telemetry configuration", async () => {
    const { p, cloud } = await applied();
    cloud.requests.length = 0;
    const result = await p.run("observe", p.cwd);
    expect(result.code).toBe(0);
    const request = cloud.requests.find(({ path }) =>
      path.endsWith("/inventory"),
    );
    expect(request?.headers.get("authorization")).toBe(`Bearer ${CREDENTIAL}`);
    expect(request?.body).toMatchObject({
      host: "claude-code",
      drift: 0,
      unmanaged: expect.any(Object),
    });
    expect(request?.body).not.toHaveProperty("project");
    expect(request?.body).not.toHaveProperty("environment");
  });

  test.each([false, true])(
    "a fresh pause blocks a covered call in watch=%s",
    async (watch) => {
      const { p, cloud } = await applied({ watch });
      const run = hook(p);
      const read = JSON.stringify({
        ...JSON.parse(readSource(p.cwd)),
        agent_type: "support",
      });
      expect((await run(read)).out).toBe("");
      cloud.remote.paused = true;
      expect((await run(read)).out).toContain("access for support is paused");
      cloud.remote.paused = false;
      expect((await run(read)).out).toBe("");
    },
  );

  test("a takeover names the new project and blocks despite a warm cache", async () => {
    const { cloud, read, run } = await warmCache();
    cloud.remote.takeover = true;
    expect((await run(read)).out).toContain(
      "Project New owner now owns this environment",
    );
  });

  test("metadata-free access asks for the configured entry agent", async () => {
    const { p, cloud } = await applied();
    cloud.remote.paused = true;
    const result = await hook(p, "--agent", "lead")(readSource(p.cwd));
    expect(result.out).toContain("access for lead is paused");
  });

  test("a live mismatch keeps the pin, while credential refusal blocks", async () => {
    const { cloud, read, run } = await warmCache();
    cloud.remote.different = true;
    expect(await run(read)).toMatchObject({
      out: "",
      err: expect.stringContaining("live policy differs from the lock"),
    });
    cloud.remote.status = 403;
    expect((await run(read)).out).toContain("policy fetch returned HTTP 403");
  });

  test.each(["*", '"version-2"'])(
    "ignores a poisoned cache validator %s",
    async (tag) => {
      const { p, cloud, read, run } = await warmCache();
      const cache = join(
        spoolFolder(p.home, join(p.cwd, CONNECT_FILE), "policies"),
        "live.json",
      );
      writeFileSync(
        cache,
        JSON.stringify({
          ...JSON.parse(readFileSync(cache, "utf8")),
          etag: tag,
        }),
      );
      cloud.remote.offline = true;
      expect((await run(read)).out).toContain(
        "fresh agent access status is unavailable",
      );
      cloud.remote.offline = false;
      cloud.remote.different = true;
      expect(await run(read)).toMatchObject({
        out: "",
        err: expect.stringContaining("live policy differs from the lock"),
      });
      const pulls = cloud.requests.filter(({ path }) =>
        path.endsWith("/policy"),
      );
      expect(pulls.at(-1)?.headers.get("if-none-match")).toBeNull();
    },
  );

  test("watch records the local deny but lets the call continue", async () => {
    const { p } = await applied({ watch: true });
    const result = await hook(p)(call(p.cwd, "Bash", { command: "ls" }));
    expect(result).toMatchObject({ code: 0, out: "" });
    const root = spoolFolder(p.home, join(p.cwd, CONNECT_FILE), "decisions");
    const folder = join(root, readdirSync(root)[0]!);
    const entries = readFileSync(join(folder, "spool.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const entry = entries.find(({ type }) => type === "decision");
    expect(entry).toMatchObject({
      type: "decision",
      item: {
        verdict: "would_deny",
        policy_digest: JSON.parse(p.read(CONNECT_FILE)).policy_digest,
      },
    });
  });

  test("a connected watch hook audits and blocks when its setup guard cannot be read", async () => {
    const { p } = await applied({ watch: true });
    rmSync(join(p.cwd, ".nodrail/protected.txt"));
    const result = await hook(p)(
      call(p.cwd, "Read", { file_path: "src/a.ts" }),
    );
    expect(result.out).toContain("can't read the protect list");
    const folder = spoolFolder(
      p.home,
      join(p.cwd, CONNECT_FILE),
      "watch-audit",
    );
    expect(
      JSON.parse(readFileSync(join(folder, "spool.jsonl"), "utf8")),
    ).toMatchObject({
      type: "evaluation_failure",
      host: "claude-code",
      call: expect.stringMatching(/^claude-code:/),
      reason: expect.stringContaining("can't read the protect list"),
    });
  });

  test.each([false, true])(
    "watch still denies edits to hook-owned files (unreadable ledger: %s)",
    async (brokenLedger) => {
      const { p } = await applied({ watch: true });
      if (brokenLedger) {
        const directory = join(p.home, "runs");
        p.env.NODRAIL_LEDGER = directory;
        p.env.NODRAIL_RUN = "broken";
        mkdirSync(directory);
        writeFileSync(runFile(directory, "broken"), "invalid ledger line\n");
      }
      const run = hook(p);
      for (const file of [
        CONNECT_FILE,
        ".claude/settings.json",
        ".nodrail/protected.txt",
        join(p.home, ".nodrail/watch-audit/spool.jsonl"),
      ]) {
        const result = await run(
          call(p.cwd, "Write", { file_path: file, content: "{}" }),
        );
        expect(result.out).toContain('"permissionDecision":"deny"');
        expect(result.out).toContain("changing it is denied");
      }
    },
  );

  test.each([
    { url: "https://different.example" },
    { credential: { fromEnv: "NODRAIL_TOKEN" } },
    { lock: undefined },
    { lock: "./fake.lock.yaml" },
  ])(
    "refuses an unbound connection before making any request (%j)",
    async (changed) => {
      const { p, cloud } = await applied({ watch: true });
      p.write(".nodrail/fake.lock.yaml", p.read("nodrail.lock.yaml"));
      p.write(
        CONNECT_FILE,
        JSON.stringify({ ...JSON.parse(p.read(CONNECT_FILE)), ...changed }),
      );
      cloud.requests.length = 0;
      const result = await hook(p)(
        call(p.cwd, "Read", { file_path: "src/a.ts" }),
      );
      expect(result.out).toContain("repository lock differs");
      expect(cloud.requests).toEqual([]);
    },
  );

  test("a missing or unreadable repository lock prevents authentication", async () => {
    const { p, cloud } = await applied();
    const read = readSource(p.cwd);
    cloud.requests.length = 0;
    rmSync(join(p.cwd, "nodrail.lock.yaml"));
    expect((await hook(p)(read)).out).toContain("repository lock differs");
    p.write("nodrail.lock.yaml", "workspace: [");
    expect((await hook(p)(read)).out).toContain("repository lock differs");
    expect(cloud.requests).toEqual([]);
  });

  test("posts the outcome and settles the admitted call while live policy has drifted", async () => {
    const { p, cloud } = await applied({
      rules: `- required_engine_version: 5
- budget: Dispatch count
  id: dispatch-count
  count: { tool: claude-code, operation: agent }
  limit: 3
  per: run
  otherwise: deny
- budget: Subagent tokens
  id: tokens
  tokens: 1000
  source: measured
  per: run
  otherwise: deny
`,
    });
    const directory = join(p.home, "runs");
    const runKey = "connected-outcome";
    p.env.NODRAIL_LEDGER = directory;
    p.env.NODRAIL_RUN = runKey;
    const pre = JSON.stringify({
      ...JSON.parse(
        call(p.cwd, "Agent", {
          subagent_type: "publisher",
          description: "Publish",
          prompt: "Proceed",
        }),
      ),
      agent_type: "lead",
    });
    const run = hook(p, "--agent", "lead");
    expect((await run(pre)).out).toBe("");
    expect(readRun(directory, runKey)).toContainEqual(
      expect.objectContaining({
        type: "budget.reserved",
        budget: "dispatch-count",
      }),
    );
    cloud.remote.different = true;
    expect(await run(pre)).toMatchObject({
      out: "",
      err: expect.stringContaining("live policy differs from the lock"),
    });
    cloud.requests.length = 0;
    const outcome = JSON.stringify({
      ...JSON.parse(pre),
      hook_event_name: "PostToolUse",
      tool_response: { totalTokens: 321 },
    });
    expect(await run(outcome)).toMatchObject({ code: 0, out: "", err: "" });
    expect(await run(outcome)).toMatchObject({ code: 0, out: "", err: "" });
    expect(cloud.requests).toEqual([]);
    const ledger = readRun(directory, runKey);
    expect(ledger.filter((entry) => entry.type === "budget.settled")).toEqual([
      expect.objectContaining({ state: "consumed" }),
    ]);
    expect(ledger.filter((entry) => entry.type === "budget.measured")).toEqual([
      expect.objectContaining({ path: "tokens", amount: 321 }),
    ]);
    const root = spoolFolder(p.home, join(p.cwd, CONNECT_FILE), "decisions");
    const queue = readFileSync(
      join(root, readdirSync(root)[0]!, "spool.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(queue).toContainEqual({
      type: "outcome",
      outcome: "success",
      agent: "lead",
      key: queue.find(({ type }) => type === "decision").item.idempotency_key,
    });
  });

  test("apply refuses when the live policy can't be checked", async () => {
    const { p } = await connected();
    delete p.env.NODRAIL_TOKEN;
    const plan = await p.run("plan");
    expect(plan.code).toBe(1);
    expect(plan.out).toContain("Sign in to");
    const apply = await p.run("apply", "--yes");
    expect(apply.code).toBe(1);
    expect(apply.out).toContain("Sign in to");
    expect(() => p.read(".claude/settings.json")).toThrow();
  });

  test("without its credential the hook blocks a call, and never a step", async () => {
    const { p } = await applied();
    delete p.env.NODRAIL_CREDENTIAL;
    const run = hook(p);
    const blocked = await run(call(p.cwd, "Bash", { command: "ls" }));
    expect(blocked.out).toContain("NODRAIL_CREDENTIAL isn't set");
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

const verifiedRules = `- required_engine_version: 5
- contracts:
    shapes:
      ci-result:
        properties:
          status: { values: [passed, failed], report: true }
    evidence:
      ci-tests:
        shape: ci-result
        producers:
          - { class: externally-verified, verifier: github-actions }
        subject: revision
- gate: Tested before a push
  id: tested
  command: { prefix: git push }
  requires:
    - { evidence: ci-tests, authority: externally-verified, subject: revision, where: { status: passed } }
  otherwise: deny
`;
