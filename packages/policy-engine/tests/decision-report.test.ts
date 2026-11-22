// Decision reporting to the control plane (R388, M1.3): the hook queues each
// decision and outcome on disk and a detached sender batches them to
// `POST /runtime/decisions`. Nothing here may change or delay a decision.
import { createServer, type IncomingMessage } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  callKey,
  decisionItem,
  decisionSink,
  outcomeOf,
} from "../src/decision-report";
import { sendDecisionQueue } from "../src/decision-sender";
import type { Observed } from "../src/hook-telemetry";
import { compilePolicies } from "../src/yaml";
import { enqueue, readStatus, spoolFolder } from "../src/telemetry";
import { cli, homeAt, self } from "./run-cli.ts";

const RULES = `- rule: Edit sources
  tool: files
  operation: file.write
  resource: { kind: file, match: any }
  effect: allow
`;

function compiled() {
  const result = compilePolicies([{ name: "rules.yaml", text: RULES }]);
  if (!result.ok) throw new Error("the test's rules don't compile");
  return result.document;
}

const fresh = (prefix = "nodrail-report-") =>
  mkdtempSync(join(tmpdir(), prefix));

const pre = (id: string, extra: object = {}) =>
  JSON.stringify({
    hook_event_name: "PreToolUse",
    session_id: "s-1",
    tool_use_id: id,
    tool_name: "Write",
    tool_input: { file_path: "src/a.ts", content: "x" },
    cwd: "/work",
    ...extra,
  });

const post = (id: string, failed = false) =>
  JSON.stringify({
    hook_event_name: failed ? "PostToolUseFailure" : "PostToolUse",
    session_id: "s-1",
    tool_use_id: id,
    tool_name: "Write",
  });

function project(url = "http://127.0.0.1:9") {
  const dir = fresh();
  const rules = join(dir, "rules.yaml");
  writeFileSync(rules, RULES);
  const file = join(dir, "connect.json");
  writeFileSync(
    file,
    JSON.stringify({
      url,
      workspace: "acme",
      environment: "development",
      decide: "local",
      credential: { fromEnv: "NODRAIL_CREDENTIAL" },
    }),
  );
  return { dir, rules, file };
}

/** A file write the hook let through, as it judged it. */
const allowedWrite = (
  id: string,
  params: Record<string, string>,
  decision: Observed["judged"]["decision"],
): Observed["judged"] => ({
  result: { stdout: "", stderr: "", exitCode: 0 },
  action: {
    tool: "files",
    operation: "file.write",
    resource: { kind: "file", id },
    params,
  },
  decision,
});

const queued = (folder: string) =>
  readdirSync(folder)
    .filter((name) => name === "spool.jsonl" || name.startsWith("batch-"))
    .flatMap((name) =>
      readFileSync(join(folder, name), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    );

describe("what the hook queues", () => {
  test("a call's key is the same at its decision and its outcome", () => {
    const key = callKey("claude-code", { session_id: "s", tool_use_id: "t" });
    expect(key).toMatch(/^claude-code:[0-9a-f]{40}$/);
    expect(callKey("claude-code", { session_id: "s", tool_use_id: "t" })).toBe(
      key,
    );
    expect(callKey("codex", { session_id: "s", tool_use_id: "t" })).not.toBe(
      key,
    );
    const outcome = outcomeOf(
      JSON.stringify({
        hook_event_name: "PostToolUse",
        session_id: "s",
        tool_use_id: "t",
      }),
      "claude-code",
    );
    expect(outcome).toEqual({ type: "outcome", key, outcome: "success" });
    expect(outcomeOf(post("t", true), "claude-code")?.outcome).toBe("failure");
    expect(outcomeOf(pre("t"), "claude-code")).toBeNull();
  });

  test("a decision names the action, what the host was told, the rule and the policy", () => {
    const document = compiled();
    const observed: Observed = {
      judged: allowedWrite("src/a.ts", {}, {
        outcome: "allow",
        matchedRuleId: document.rules[0]!.id,
        explanation: "Allowed.",
      } as never),
      event: { session_id: "s", tool_use_id: "t" },
      agent: "dev",
      run: "feat/a",
      step: "dev-1",
    };
    const item = decisionItem(observed, {
      host: "claude-code",
      document,
      policyDigest: "c".repeat(64),
      now: new Date("2026-11-22T10:00:00Z"),
    });
    expect(item).toEqual({
      idempotency_key: callKey("claude-code", observed.event!),
      tool: "files",
      operation: "file.write",
      resource: { kind: "file", id: "src/a.ts" },
      params: {},
      verdict: "allow",
      rule: { id: document.rules[0]!.id, name: "Edit sources" },
      reason: "Allowed.",
      decided_at: "2026-11-22T10:00:00.000Z",
      policy_digest: "c".repeat(64),
      run: { key: "feat/a", step: { id: "dev-1", agent: "dev" } },
    });
    // A refusal before the call was described has nothing to record.
    expect(
      decisionItem(
        { ...observed, judged: { ...observed.judged, action: null } },
        { host: "claude-code", document, policyDigest: null },
      ),
    ).toBeNull();
  });

  test("the hook's answer is the same with and without the sink, and never waits", async () => {
    const { rules, file } = project();
    const home = fresh("nodrail-home-");
    const restore = homeAt(home);
    try {
      const without = await cli(["hook", rules], pre("toolu_1"));
      const started = Date.now();
      const withSink = await cli(
        ["hook", rules, "--report", file],
        pre("toolu_1"),
      );
      // The control plane at 127.0.0.1:9 never answers; nothing waited on it.
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(withSink).toEqual(without);
      const denied = await cli(
        ["hook", rules],
        pre("toolu_2", {
          tool_name: "Bash",
          tool_input: { command: "rm -rf /" },
        }),
      );
      const deniedWith = await cli(
        ["hook", rules, "--report", file],
        pre("toolu_2", {
          tool_name: "Bash",
          tool_input: { command: "rm -rf /" },
        }),
      );
      expect(deniedWith).toEqual(denied);
      await cli(["hook", rules, "--report", file], post("toolu_1"));
      const folder = spoolFolder(home, file, "decisions");
      const entries = queued(folder);
      expect(entries.map((entry) => entry.type)).toEqual([
        "decision",
        "decision",
        "outcome",
      ]);
      expect(entries[0].item).toMatchObject({
        verdict: "allow",
        policy_digest: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      expect(entries[1].item).toMatchObject({ verdict: "deny", rule: null });
      expect(entries[2].key).toBe(entries[0].item.idempotency_key);
    } finally {
      restore();
    }
  });

  test("a report file that can't be read turns reporting off, not the hook", async () => {
    const { rules } = project();
    const result = await cli(
      ["hook", rules, "--report", join(fresh(), "missing.json")],
      pre("toolu_3"),
    );
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("decision reporting is off");
  });

  test("the queue is bounded: past it, entries are dropped and counted", () => {
    const { file } = project();
    const home = fresh("nodrail-home-");
    const document = compiled();
    const sink = decisionSink({
      file,
      host: "claude-code",
      document,
      self: ["/nonexistent"],
      warn: () => undefined,
      home,
    });
    const folder = spoolFolder(home, file, "decisions");
    // A sender is at work (its lock is fresh), so none starts here.
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "sending"), "1");
    const observed: Observed = {
      judged: allowedWrite("a", { content: "x".repeat(20_000) }, null),
      event: null,
      agent: null,
    };
    for (let index = 0; index < 40; index++) sink!.observe(observed);
    const kept = queued(folder).length;
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(40);
    expect(readFileSync(join(folder, "dropped"), "utf8")).toHaveLength(
      40 - kept,
    );
  });
});

type Seen = { path: string; body: any };

/** A control plane that records host decisions, deduplicating by key. */
function controlPlane(options: { failFirst?: number; refuse?: string[] } = {}) {
  const seen: Seen[] = [];
  const rows = new Map<string, string>();
  let failures = options.failFirst ?? 0;
  const send = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(init.body as string);
    seen.push({ path, body });
    if (failures > 0) {
      failures -= 1;
      return new Response("{}", { status: 503 });
    }
    if (path.endsWith("/decisions"))
      return Response.json({
        results: body.decisions.map((item: { idempotency_key: string }) => {
          const key = item.idempotency_key;
          if (options.refuse?.includes(key))
            return { key, error: { code: "IDEMPOTENCY_CONFLICT" } };
          if (!rows.has(key)) rows.set(key, `row-${rows.size + 1}`);
          return { key, action_id: rows.get(key) };
        }),
      });
    return Response.json({ recorded: true });
  }) as unknown as typeof fetch;
  return { seen, rows, send };
}

function queueFolder(entries: object[]) {
  const folder = fresh("nodrail-queue-");
  for (const entry of entries) enqueue(folder, entry);
  const { file } = project("https://nodrail.example");
  return { folder, file };
}

const item = (key: string) => ({
  type: "decision",
  item: {
    idempotency_key: key,
    tool: "files",
    operation: "file.write",
    resource: { kind: "file", id: "a" },
    params: {},
    verdict: "allow",
    decided_at: "2026-11-22T10:00:00.000Z",
    policy_digest: null,
  },
});

const env = { NODRAIL_CREDENTIAL: "ndr_000000000000_secret" };

describe("the sender", () => {
  test("batches decisions, then reports outcomes on the rows they got", async () => {
    const keys = Array.from(
      { length: 150 },
      (_, index) => `claude-code:${index}`,
    );
    const { folder, file } = queueFolder([
      ...keys.map(item),
      { type: "outcome", key: keys[0], outcome: "success" },
    ]);
    const plane = controlPlane();
    await sendDecisionQueue(folder, file, env, plane.send);
    const batches = plane.seen.filter((call) =>
      call.path.endsWith("/decisions"),
    );
    expect(batches.map((call) => call.body.decisions.length)).toEqual([
      100, 50,
    ]);
    expect(plane.seen.at(-1)).toEqual({
      path: "/api/v1/runtime/actions/row-1/reports",
      body: { report_key: `${keys[0]}:outcome`, outcome: "success" },
    });
    expect(readStatus(folder)).toMatchObject({ state: "ok", sent: 151 });
    expect(queued(folder)).toEqual([]);
  });

  test("a control plane that is down keeps the queue; the retry sends the same keys", async () => {
    const { folder, file } = queueFolder([item("k:1"), item("k:2")]);
    const plane = controlPlane({ failFirst: 1 });
    await sendDecisionQueue(folder, file, env, plane.send);
    expect(readStatus(folder)).toMatchObject({
      state: "degraded",
      sent: 0,
      retryAfter: expect.any(Number),
    });
    expect(queued(folder)).toHaveLength(2);
    await sendDecisionQueue(folder, file, env, plane.send);
    const keysSent = plane.seen.map((call) =>
      call.body.decisions.map(
        (entry: { idempotency_key: string }) => entry.idempotency_key,
      ),
    );
    expect(keysSent).toEqual([
      ["k:1", "k:2"],
      ["k:1", "k:2"],
    ]);
    expect(readStatus(folder)).toMatchObject({ state: "ok", sent: 2 });
    expect(plane.rows.size).toBe(2);
  });

  test("a failure after the decisions went in counts nothing twice", async () => {
    const { folder, file } = queueFolder([
      item("k:1"),
      { type: "outcome", key: "k:1", outcome: "failure" },
    ]);
    let calls = 0;
    const plane = controlPlane();
    const flaky = (async (url: string, init: RequestInit) => {
      calls += 1;
      if (calls === 2) throw new Error("connection reset");
      return plane.send(url, init);
    }) as unknown as typeof fetch;
    await sendDecisionQueue(folder, file, env, flaky);
    expect(readStatus(folder)).toMatchObject({
      sent: 0,
      error: "connection reset",
    });
    await sendDecisionQueue(folder, file, env, flaky);
    expect(readStatus(folder)).toMatchObject({ state: "ok", sent: 2 });
    expect(plane.rows.size).toBe(1);
  });

  test("refusals are counted and never resent", async () => {
    const { folder, file } = queueFolder([
      item("k:1"),
      item("k:bad"),
      { type: "outcome", key: "k:bad", outcome: "success" },
    ]);
    const plane = controlPlane({ refuse: ["k:bad"] });
    await sendDecisionQueue(folder, file, env, plane.send);
    expect(readStatus(folder)).toMatchObject({
      state: "degraded",
      sent: 1,
      rejected: 2,
      lastRejection: "IDEMPOTENCY_CONFLICT",
    });
    expect(queued(folder)).toEqual([]);
    const forbidden = queueFolder([item("k:2")]);
    await sendDecisionQueue(forbidden.folder, forbidden.file, env, (async () =>
      Response.json(
        { error: { code: "FORBIDDEN" } },
        { status: 403 },
      )) as unknown as typeof fetch);
    expect(readStatus(forbidden.folder)).toMatchObject({
      rejected: 1,
      lastRejection: "FORBIDDEN",
    });
  });

  test("a credential that isn't set degrades sending and keeps the queue", async () => {
    const { folder, file } = queueFolder([item("k:1")]);
    await sendDecisionQueue(folder, file, {}, controlPlane().send);
    expect(readStatus(folder)).toMatchObject({
      state: "degraded",
      error: "NODRAIL_CREDENTIAL isn't set",
    });
    expect(queued(folder)).toHaveLength(1);
  });
});

describe("end to end, detached", () => {
  const got: { url: string; body: any; auth: string | undefined }[] = [];
  let url = "";
  const server = createServer((request: IncomingMessage, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      got.push({
        url: request.url ?? "",
        body,
        auth: request.headers.authorization,
      });
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify(
          request.url?.endsWith("/decisions")
            ? {
                results: body.decisions.map(
                  (entry: { idempotency_key: string }) => ({
                    key: entry.idempotency_key,
                    action_id: "row-1",
                  }),
                ),
              }
            : { recorded: true },
        ),
      );
    });
  });
  beforeAll(
    () =>
      new Promise<void>((done) =>
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
          done();
        }),
      ),
  );
  afterAll(() => new Promise<void>((done) => server.close(() => done())));

  test("the hook queues the decision and its sender records it in Nodrail", async () => {
    const { rules, file } = project(url);
    const home = fresh("nodrail-home-");
    const restore = homeAt(home);
    process.env.NODRAIL_CREDENTIAL = "ndr_000000000000_secret";
    try {
      const result = await cli(
        ["hook", rules, "--report", file],
        pre("toolu_9"),
      );
      expect(result.code).toBe(0);
    } finally {
      restore();
      delete process.env.NODRAIL_CREDENTIAL;
    }
    for (let wait = 0; wait < 100 && got.length === 0; wait++)
      await new Promise((done) => setTimeout(done, 100));
    expect(got[0]).toMatchObject({
      url: "/api/v1/runtime/decisions",
      auth: "Bearer ndr_000000000000_secret",
      body: { decisions: [{ verdict: "allow", tool: "files" }] },
    });
    expect(existsSync(self[2]!)).toBe(true);
  }, 20_000);
});
