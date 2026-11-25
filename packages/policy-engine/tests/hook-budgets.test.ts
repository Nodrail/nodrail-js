import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { callKey, decisionSink, outcomeOf } from "../src/decision-report.ts";
import { hookCommand, type HookRun } from "../src/hook-command.ts";
import { policyDigestWarning } from "../src/hook-policy-digest.ts";
import {
  remoteReadings,
  sharedLimitsForOutcome,
} from "../src/outcome-readings.ts";
import type { NumericBudget } from "../src/policies.ts";
import { runFile } from "../src/ledger.ts";
import {
  decisionDestination,
  decisionFolder,
} from "../src/decision-destination.ts";
import { compilePolicies } from "../src/yaml.ts";
import { homeAt } from "./run-cli.ts";

const RULES = `- required_engine_version: 5
- rule: Publish
  tool: outbox
  operation: publish
  resource: { kind: mcp_tool, match: any }
  effect: allow
- budget: Shared publishing
  id: daily
  count: { tool: outbox, operation: publish }
  limit: 1
  per: day
  timezone: UTC
  across: environment
`;
const digest = createHash("sha256").update(RULES).digest("hex");
const compiled = compilePolicies([{ name: "rules.yaml", text: RULES }]);
if (!compiled.ok) throw new Error(JSON.stringify(compiled.issues));
if (compiled.document.version !== 4)
  throw new Error("test policy needs numeric limits");
const { document } = compiled;

const call = {
  tool_name: "mcp__outbox__publish",
  tool_input: { message: "private tool input" },
  session_id: "s1",
  tool_use_id: "a1",
};

const response = (state: "ok" | "over", expires_at: string | null) =>
  Response.json({
    expires_at,
    limits: [
      {
        id: "daily",
        name: "Shared publishing",
        label: "enforced-allowance",
        unit: "calls",
        limit: 1,
        used: state === "ok" ? 0 : 1,
        reserved: 0,
        unknown: 0,
        unread: 0,
        amount: 1,
        state,
        effect: "deny",
        resets: null,
      },
    ],
  });

const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const remove of cleanup.splice(0).reverse()) remove();
});

function setup(
  overrides: Partial<HookRun["values"]> = {},
  policy = RULES,
  enforce?: "on" | "watch",
) {
  const root = mkdtempSync(join(tmpdir(), "nodrail-shared-budget-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  cleanup.push(homeAt(root));
  const folder = join(root, ".nodrail");
  mkdirSync(folder);
  const file = join(folder, "connect.json");
  const policyDigest = createHash("sha256").update(policy).digest("hex");
  const destination = {
    url: "http://127.0.0.1:9",
    credential: { fromEnv: "HOST_TOKEN" },
  };
  if (enforce) {
    const connect = {
      ...destination,
      decide: "cloud",
      enforce,
      workspace: "example",
      environment: "dev",
    };
    const manifest = JSON.stringify({ connect });
    const revision = "a".repeat(64);
    writeFileSync(join(root, "nodrail.yaml"), manifest);
    writeFileSync(
      join(root, "nodrail.lock.yaml"),
      JSON.stringify({
        manifest: {
          sha256: createHash("sha256").update(manifest).digest("hex"),
        },
        effective: { sha256: policyDigest },
        workspace: { sha256: revision },
      }),
    );
    writeFileSync(
      file,
      JSON.stringify({
        ...connect,
        lock: "../nodrail.lock.yaml",
        workspace_revision: revision,
        policy_digest: policyDigest,
      }),
    );
  } else {
    writeFileSync(file, JSON.stringify(destination));
  }
  const rules = join(root, "rules.yaml");
  writeFileSync(rules, policy);
  const result = compilePolicies([{ name: "rules.yaml", text: policy }]);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  const ledger = join(root, "runs");
  const env = {
    NODRAIL_LEDGER: ledger,
    NODRAIL_RUN: "shared",
    HOST_TOKEN: "test-token",
  };
  const event = { ...call, cwd: root, hook_event_name: "PreToolUse" };
  const run = async (input: Record<string, unknown> = event) => {
    let stdout = "";
    let stderr = "";
    const code = await hookCommand(
      {
        values: {
          ...(enforce ? { connect: file } : { report: file }),
          ...overrides,
        },
        now: new Date(),
        paths: [rules],
      },
      {
        env,
        self: [join(root, "detached-sender.test.mjs")],
        readStdin: async () => JSON.stringify(input),
        write: (text) => {
          stdout += text;
        },
        writeError: (text) => {
          stderr += text;
        },
      },
      async () =>
        result.ok ? { document: result.document, policyDigest } : null,
    );
    return { code, stdout, stderr };
  };
  writeFileSync(join(root, "detached-sender.test.mjs"), "");
  return { run, root, ledger, event, file, policyDigest };
}

test("checks a shared budget before the run lock and warns when the cache differs from the lock", async () => {
  const { run, root, ledger, event } = setup();
  writeFileSync(
    join(root, "nodrail.lock.yaml"),
    `effective:\n  sha256: "${"f".repeat(64)}"\n`,
  );
  const until = new Date(Date.now() + 5_000).toISOString();
  const fetch = vi.fn((url: string, init: RequestInit) => {
    if (url.endsWith("/reserve")) return response("ok", until);
    const { claim_id } = JSON.parse(init.body as string);
    return Response.json({
      claim_id,
      expires_at: until,
      started_at: new Date().toISOString(),
    });
  });
  vi.stubGlobal("fetch", fetch);
  const result = await run();
  expect(result).toMatchObject({
    code: 0,
    stdout: "",
    stderr: expect.stringContaining("differs from nodrail.lock.yaml"),
  });
  expect(fetch).toHaveBeenCalledTimes(2);
  const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("http://127.0.0.1:9/api/v1/runtime/budgets/reserve");
  expect(JSON.parse(init.body as string)).toEqual({
    call_fingerprint: callKey("claude-code", event),
    policy_digest: digest,
    calls: [{ tool: "outbox", operation: "publish" }],
    run: { key: "shared" },
  });
  expect(fetch.mock.calls[1]?.[0]).toBe(
    "http://127.0.0.1:9/api/v1/runtime/budgets/start",
  );
  expect(JSON.parse(fetch.mock.calls[1]![1].body as string)).toEqual({
    call_fingerprint: callKey("claude-code", event),
    policy_digest: digest,
    claim_id: expect.any(String),
  });
  expect(existsSync(runFile(ledger, "shared"))).toBe(true);
});

test.each(["another worker", "expired acknowledgment", "refused"] as const)(
  "denies a grant when start returns %s",
  async (kind) => {
    const { run } = setup();
    const until = new Date(Date.now() + 5_000).toISOString();
    vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
      if (url.endsWith("/reserve")) return response("ok", until);
      const claim = JSON.parse(init.body as string).claim_id;
      if (kind === "refused")
        return Response.json({
          claim_id: null,
          expires_at: null,
          started_at: null,
        });
      return Response.json({
        claim_id:
          kind === "another worker"
            ? "e49c57c3-d201-4f3c-a784-b1cc991b2849"
            : claim,
        expires_at:
          kind === "expired acknowledgment" ? new Date(0).toISOString() : until,
        started_at: new Date().toISOString(),
      });
    });
    expect((await run()).stdout).toContain(
      kind === "expired acknowledgment" ? "lease expired" : "claim was refused",
    );
  },
);

test("uses the acknowledged server time when the host clock is behind", async () => {
  const { run } = setup();
  const until = new Date(Date.now() + 60_000).toISOString();
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    if (url.endsWith("/reserve")) return response("ok", until);
    await new Promise((resolve) => setTimeout(resolve, 30));
    return Response.json({
      claim_id: JSON.parse(init.body as string).claim_id,
      expires_at: until,
      started_at: new Date(Date.parse(until) - 10).toISOString(),
    });
  });
  expect((await run()).stdout).toContain("lease expired before execution");
});

test("queues the acknowledged outcome with its original digest", async () => {
  const { run, event, root, file } = setup();
  const until = new Date(Date.now() + 5_000).toISOString();
  vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
    if (url.endsWith("/reserve")) return response("ok", until);
    return Response.json({
      claim_id: JSON.parse(init.body as string).claim_id,
      expires_at: until,
      started_at: new Date().toISOString(),
    });
  });
  expect((await run()).stdout).toBe("");
  await run({ ...event, hook_event_name: "PostToolUse" });
  expect(queuedOutcomes(root, file)).toContainEqual(
    successfulOutcome(event, digest),
  );
});

function successfulOutcome(
  event: NonNullable<Parameters<typeof callKey>[1]>,
  policyDigest?: string,
) {
  const key = callKey("claude-code", event);
  return {
    type: "outcome",
    key,
    outcome: "success",
    ...(policyDigest ? { settlements: [{ key, policyDigest }] } : {}),
  };
}

function queuedOutcomes(root: string, file: string) {
  const { binding } = decisionDestination(file, { HOST_TOKEN: "test-token" });
  const path = join(decisionFolder(root, file, binding), "spool.jsonl");
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter(({ type }) => type === "outcome");
}

test.each([false, true])(
  "a Copilot patch reports exact claimed parts when a part is refused: %s",
  async (refused) => {
    const policy = RULES.replaceAll("outbox", "files")
      .replaceAll("publish", "file.write")
      .replace("mcp_tool", "file");
    const { run, root, file, policyDigest } = setup(
      { host: "copilot" },
      policy,
    );
    const event = {
      cwd: root,
      sessionId: "s-1",
      toolCallId: "patch",
      toolName: "apply_patch",
      toolArgs: {
        patch:
          "*** Begin Patch\n*** Add File: a.txt\n+a\n*** Add File: b.txt\n+b\n*** End Patch",
      },
    };
    const key = callKey("copilot", {
      session_id: event.sessionId,
      tool_use_id: event.toolCallId,
    });
    const until = new Date(Date.now() + 5_000).toISOString();
    const requests: string[] = [];
    vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
      requests.push(url);
      if (url.endsWith("/reserve")) return response("ok", until);
      const { call_fingerprint, claim_id } = JSON.parse(init.body as string);
      return refused && call_fingerprint === `${key}#1`
        ? Response.json({ claim_id: null, expires_at: null, started_at: null })
        : Response.json({
            claim_id,
            expires_at: until,
            started_at: new Date().toISOString(),
          });
    });
    const answer = await run(event);
    expect(requests.slice(0, 2)).toEqual([
      "http://127.0.0.1:9/api/v1/runtime/budgets/reserve",
      "http://127.0.0.1:9/api/v1/runtime/budgets/reserve",
    ]);
    if (refused) {
      expect(answer.stdout).toContain("claim was refused");
      expect(queuedOutcomes(root, file)).toEqual([
        expect.objectContaining({
          cancellation: true,
          outcome: "failure",
          settlements: [{ key: `${key}#0`, policyDigest }],
        }),
      ]);
    } else {
      expect(answer.stdout).toBe("");
      await run({ ...event, toolResult: { resultType: "success" } });
      expect(queuedOutcomes(root, file)).toEqual([
        expect.objectContaining({
          key,
          outcome: "success",
          settlements: [0, 1].map((part) => ({
            key: `${key}#${part}`,
            policyDigest,
          })),
        }),
      ]);
    }
  },
);

test.each([
  ["over limit", () => response("over", null), "this call needs 1 more"],
  ["expired", () => response("ok", new Date(0).toISOString()), "lease expired"],
  [
    "refused",
    () => new Response(null, { status: 403 }),
    "control plane could not confirm",
  ],
  ["missing lease", () => response("ok", null), "did not grant a budget lease"],
  [
    "missing a requested budget",
    () => Response.json({ expires_at: null, limits: [] }),
    "did not confirm every shared budget",
  ],
  [
    "using a stale digest",
    () =>
      Response.json({
        expires_at: null,
        limits: [],
        reason: "The host policy differs from the published policy.",
      }),
    "differs from the published policy",
  ],
  [
    "offline",
    () => {
      throw new Error("network");
    },
    "control plane could not confirm",
  ],
] as const)(
  "denies a shared budget that is %s",
  async (_name, send, reason) => {
    const { run, ledger } = setup();
    const lockedDuringFetch: boolean[] = [];
    vi.stubGlobal("fetch", async () => {
      lockedDuringFetch.push(existsSync(`${runFile(ledger, "shared")}.lock`));
      return send();
    });
    expect((await run()).stdout).toContain(reason);
    expect(lockedDuringFetch).toEqual([false]);
  },
);

test.each([
  {
    name: "a call outside shared budgets",
    eventPatch: { tool_name: "Bash", tool_input: { command: "ls" } },
    options: {},
    reason: "no rule covers",
  },
  {
    name: "a shared-budget call without a host identifier",
    eventPatch: { tool_use_id: undefined },
    options: {},
    reason: "The host could not identify this call",
  },
  {
    name: "a shared-budget call in standalone mode",
    eventPatch: {},
    options: { report: undefined },
    reason: "needs a connection to the control plane",
  },
])(
  "denies $name without a remote request",
  async ({ eventPatch, options, reason }) => {
    const { run, event } = setup(options);
    const send = vi.fn();
    vi.stubGlobal("fetch", send);
    expect((await run({ ...event, ...eventPatch })).stdout).toContain(reason);
    expect(send).not.toHaveBeenCalled();
  },
);

test("outcome hooks leave settlement to the background sender", async () => {
  const { run, event } = setup();
  const send = vi.fn();
  vi.stubGlobal("fetch", send);
  const post = { ...event, hook_event_name: "PostToolUseFailure" };
  expect(await run(post)).toEqual({ code: 0, stdout: "", stderr: "" });
  expect(
    outcomeOf(JSON.stringify(post), "claude-code", document),
  ).toMatchObject({
    outcome: "unknown",
  });
  expect(send).not.toHaveBeenCalled();
});

test("a nested cache compares with the project lock above it", () => {
  const { root } = setup();
  const cached = join(root, ".nodrail", "policy.yaml");
  const lock = join(root, "nodrail.lock.yaml");
  writeFileSync(
    lock,
    `effective:
  sha256: ${digest}
`,
  );
  expect(policyDigestWarning(cached, digest)).toBeNull();
  expect(policyDigestWarning(cached, "b".repeat(64))).toContain("differs");
  writeFileSync(lock, "effective: [invalid");
  expect(policyDigestWarning(cached, digest)).toBeNull();
});

test("reports only the measurements declared for the matching tool", () => {
  const event = {
    ...call,
    hook_event_name: "PostToolUse",
    tool_response: { structuredContent: { count: 7, invalid: -1, other: 400 } },
  };
  const budget = document.limits[0]!;
  const measured = {
    ...budget,
    source: "measured",
    label: "measured-usage",
    measure: {
      kind: "sum",
      tool: "outbox",
      operation: "publish",
      path: "result.count",
    },
  } satisfies NumericBudget;
  const bad = {
    ...measured,
    measure: { ...measured.measure, path: "result.invalid" },
  } satisfies NumericBudget;
  const unrelated = {
    ...measured,
    measure: {
      ...measured.measure,
      operation: "archive",
      path: "result.other",
    },
  } satisfies NumericBudget;
  expect(
    outcomeOf(JSON.stringify(event), "claude-code", {
      ...document,
      limits: [measured, bad, unrelated],
    }),
  ).toMatchObject({
    outcome: "success",
    measured: [{ path: "result.count", value: 7 }],
  });
  expect(sharedLimitsForOutcome({ tool_response: {} }, [measured], {})).toEqual(
    [],
  );
  const tokens = {
    ...measured,
    unit: "tokens",
    measure: { kind: "tokens" },
  } satisfies NumericBudget;
  expect(
    remoteReadings({ tool_response: { totalTokens: 17 } }, [tokens]),
  ).toEqual({ tokens: 17 });
  expect(
    remoteReadings({ tool_response: { totalTokens: "17" } }, [tokens]),
  ).toEqual({});
});

test.each(["on", "watch"] as const)(
  "verified connected policy in %s mode uses the host credential for every request",
  async (mode) => {
    const { run, event, root, file, policyDigest } = setup({}, RULES, mode);
    const until = new Date(Date.now() + 5_000).toISOString();
    const send = vi.fn((url: string, init: RequestInit) => {
      expect(new Headers(init.headers).get("authorization")).toBe(
        "Bearer test-token",
      );
      if (url.endsWith("/policy"))
        return Response.json({ source: { text: RULES, digest: policyDigest } });
      const body = JSON.parse(init.body as string);
      expect(body.policy_digest).toBe(policyDigest);
      if (url.endsWith("/reserve")) return response("ok", until);
      return Response.json({
        claim_id: body.claim_id,
        expires_at: until,
        started_at: new Date().toISOString(),
      });
    });
    vi.stubGlobal("fetch", send);
    expect(await run()).toEqual({ code: 0, stdout: "", stderr: "" });
    await run({ ...event, hook_event_name: "PostToolUse" });
    const paths = send.mock.calls.map(([url]) => new URL(url).pathname);
    const enforcing = mode === "on";
    expect(paths).toEqual(
      enforcing
        ? [
            "/api/v1/runtime/policy",
            "/api/v1/runtime/budgets/reserve",
            "/api/v1/runtime/budgets/start",
          ]
        : ["/api/v1/runtime/policy"],
    );
    expect(queuedOutcomes(root, file)).toContainEqual(
      successfulOutcome(event, enforcing ? policyDigest : undefined),
    );
  },
);

test("settles declared measurements from the admitted claim when policy is unavailable", () => {
  const { root, event, file, policyDigest } = setup();
  const key = callKey("claude-code", event)!;
  const sink = decisionSink({
    file,
    env: { HOST_TOKEN: "test-token" },
    home: root,
    host: "claude-code",
    document: { version: 1, rules: [] },
    warn: (text) => {
      throw new Error(text);
    },
    self: [join(root, "detached-sender.test.mjs")],
  })!;
  sink.remember([
    {
      key,
      policyDigest,
      expiresAt: Date.now() + 5_000,
      expiresTick: performance.now() + 5_000,
      readings: { paths: ["result.count"], tokens: true },
    },
  ]);
  sink.outcome(
    JSON.stringify({
      ...event,
      hook_event_name: "PostToolUse",
      tool_response: {
        totalTokens: 12,
        structuredContent: { count: 7, other: 400 },
      },
    }),
  );
  expect(queuedOutcomes(root, file)).toEqual([
    {
      type: "outcome",
      key,
      outcome: "success",
      measured: [{ path: "result.count", value: 7 }],
      tokens: 12,
      settlements: [{ key, policyDigest }],
    },
  ]);
});
