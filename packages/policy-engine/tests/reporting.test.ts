// Reporting contract v2 (CW-01, CW-03, CW-04): the sender counts what the
// receiver kept, refused or left unknown; it authenticates with a raw token;
// it names the project by a stable id; decisions carry the full policy
// revision; a run's steps and actions are reported too, as counts only.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { decodeSpans } from "../src/otlp-decode";
import type { SpanRecord } from "../src/otlp";
import { deliveryOf } from "../src/otlp-response";
import { policyRevision, runEventSpan, runRef } from "../src/reporting-spans";
import { runHook } from "../src/run-hook";
import type { RunEvent } from "../src/runs";
import { enqueue, readStatus, sendSpool, spoolFolder } from "../src/telemetry";
import { compilePolicies } from "../src/yaml";

const PROJECT = "3f1c2a8e-5b7d-4e0f-9a6c-1d2e3f405162";

const span = (id: string): SpanRecord => ({
  traceId: "0af7651916cd43dd8448eb211c80319c",
  spanId: id.padStart(16, "0"),
  name: "nodrail.decision",
  start: "1",
  end: "2",
  attributes: { "nodrail.decision": "deny" },
});

/** A project with telemetry, its queue, and spans waiting in it. */
function queued(spans: number, traces: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), "nodrail-report-"));
  mkdirSync(join(root, ".nodrail"));
  const file = join(root, ".nodrail", "telemetry.json");
  writeFileSync(
    file,
    JSON.stringify({
      project: "desk",
      projectId: PROJECT,
      traces: {
        endpoint: "http://127.0.0.1:9/v1/traces",
        protocol: "otlp-http/json",
        ...traces,
      },
    }),
  );
  const folder = spoolFolder(root, file);
  for (let index = 0; index < spans; index++)
    enqueue(folder, span(String(index + 1)));
  return { file, folder };
}

type Sent = { headers: Record<string, string>; body: Uint8Array };

/** A receiver answering each export with this response. */
function receiver(answer: () => Response) {
  const sent: Sent[] = [];
  const send = (async (_url: string, init: RequestInit) => {
    sent.push({
      headers: init.headers as Record<string, string>,
      body: init.body as Uint8Array,
    });
    return answer();
  }) as unknown as typeof fetch;
  return { sent, send };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("what the receiver answered", () => {
  test.each([
    [json({}), { accepted: 3, rejected: 0, unknown: 0 }],
    [
      new Response("", { status: 200 }),
      { accepted: 3, rejected: 0, unknown: 0 },
    ],
    [
      json({ partialSuccess: { rejectedSpans: "1", errorMessage: "no" } }),
      { accepted: 2, rejected: 1, unknown: 0, message: "no" },
    ],
    [
      json({ partialSuccess: { rejectedSpans: "9" } }),
      { accepted: 0, rejected: 3 },
    ],
    [
      new Response(
        Uint8Array.from([0x0a, 0x05, 0x08, 0x02, 0x12, 0x01, 0x78]),
        {
          headers: { "content-type": "application/x-protobuf" },
        },
      ),
      { accepted: 1, rejected: 2, message: "x" },
    ],
    [
      new Response(new Uint8Array(), {
        headers: { "content-type": "application/x-protobuf" },
      }),
      { accepted: 3, rejected: 0 },
    ],
    [
      new Response(Uint8Array.from([0x22, 0x00]), {
        headers: { "content-type": "application/x-protobuf" },
      }),
      { accepted: 0, unknown: 3 },
    ],
    [
      json({ partialSuccess: { rejectedSpans: "-1" } }),
      { accepted: 0, unknown: 3 },
    ],
    [new Response("not json", { status: 200 }), { accepted: 0, unknown: 3 }],
    [json({ error: {} }, 401), { accepted: 0, rejected: 3 }],
    // The receiver's text is one printable line, cut short.
    [
      json({
        partialSuccess: {
          rejectedSpans: "1",
          errorMessage: `\u001b[31mred\nline${"x".repeat(500)}`,
        },
      }),
      { message: ` [31mred line${"x".repeat(500)}`.trim().slice(0, 200) },
    ],
    [
      json({ partialSuccess: { rejectedSpans: "1", errorMessage: "\u0007" } }),
      { rejected: 1, message: null },
    ],
  ])("%#", async (response, expected) => {
    expect(await deliveryOf(response, 3)).toMatchObject({
      kind: "answered",
      ...expected,
    });
  });

  // A cut or malformed protobuf answer proves nothing: unknown, never sent.
  test.each([
    [[0x0a, 0x02]],
    [[0x0a, 0x03, 0x12, 0x05, 0x78]],
    [[0x0a, 0x02, 0x08, 0x80]],
    [[0x0a, 0x80]],
    [[0x0a, 0x00, 0xff]],
  ])("a cut protobuf answer %j counts as unknown", async (bytes) => {
    const response = new Response(Uint8Array.from(bytes), {
      headers: { "content-type": "application/x-protobuf" },
    });
    expect(await deliveryOf(response, 3)).toMatchObject({
      accepted: 0,
      rejected: 0,
      unknown: 3,
    });
  });

  test("an empty partial success is a valid answer: all kept", async () => {
    const response = new Response(Uint8Array.from([0x0a, 0x00]), {
      headers: { "content-type": "application/x-protobuf" },
    });
    expect(await deliveryOf(response, 3)).toMatchObject({
      accepted: 3,
      rejected: 0,
      unknown: 0,
    });
  });

  test.each([408, 429, 500, 503])("%s is retried", async (status) => {
    expect((await deliveryOf(new Response("", { status }), 3)).kind).toBe(
      "retry",
    );
  });
});

describe("the sender, honest about delivery", () => {
  test("a partial rejection isn't counted as sent, and the batch isn't resent", async () => {
    const { file, folder } = queued(2);
    const { sent, send } = receiver(() =>
      json({
        partialSuccess: {
          rejectedSpans: "1",
          errorMessage: "decisions not kept",
        },
      }),
    );
    await sendSpool(folder, file, {}, send);
    expect(readStatus(folder)).toMatchObject({
      state: "degraded",
      sent: 1,
      rejected: 1,
      unknown: 0,
      lastRejection: "decisions not kept",
    });
    expect(
      readdirSync(folder).filter((name) => name.startsWith("batch-")),
    ).toEqual([]);
    await sendSpool(folder, file, {}, send);
    expect(sent).toHaveLength(1);
  });

  test("an outage keeps the batch, with the same span ids, for the next try", async () => {
    const { file, folder } = queued(2);
    const down = receiver(() => new Response("", { status: 503 }));
    await sendSpool(folder, file, {}, down.send);
    expect(readStatus(folder)).toMatchObject({ state: "degraded", sent: 0 });
    const up = receiver(() => json({}));
    writeFileSync(join(folder, "status.json"), JSON.stringify({ sent: 0 }));
    await sendSpool(folder, file, {}, up.send);
    const ids = (body: Uint8Array) =>
      decodeSpans(body, "application/json")[0]!.spans.map(
        (each) => each.spanId,
      );
    expect(ids(up.sent[0]!.body)).toEqual(ids(down.sent[0]!.body));
    expect(readStatus(folder)).toMatchObject({ state: "ok", sent: 2 });
  });

  test("an answer that can't be read is unknown, not sent", async () => {
    const { file, folder } = queued(1);
    await sendSpool(
      folder,
      file,
      {},
      receiver(() => new Response("<html>")).send,
    );
    expect(readStatus(folder)).toMatchObject({
      sent: 0,
      unknown: 1,
      state: "degraded",
    });
  });

  test("a raw token as Bearer; the project by name, id and schema", async () => {
    const { file, folder } = queued(1, {
      bearer: { fromEnv: "NODRAIL_TOKEN" },
    });
    const { sent, send } = receiver(() => json({}));
    await sendSpool(
      folder,
      file,
      { NODRAIL_TOKEN: "ndp_0123456789ab_raw" },
      send,
    );
    expect(sent[0]!.headers.authorization).toBe("Bearer ndp_0123456789ab_raw");
    expect(decodeSpans(sent[0]!.body, "application/json")[0]!.resource).toEqual(
      {
        "service.name": "nodrail",
        "nodrail.schema": "2",
        "nodrail.project": "desk",
        "nodrail.project.id": PROJECT,
      },
    );
  });
});

describe("what a run reports", () => {
  test("a finished step: its verdict and counts, never its findings' text", () => {
    const reported = runEventSpan({
      run: "acme/feature-x",
      host: "claude-code",
      machine: "a".repeat(32),
      event: {
        type: "step.finished",
        step: "agent-1",
        agent: "qa",
        at: "2026-11-20T10:00:00.000Z",
        verdict: "fail",
        findings: ["fail", "pass"],
        usage: { tokens: 1200, usd: 0.04 },
      },
    });
    expect(reported.name).toBe("nodrail.run.event");
    expect(reported.attributes).toEqual({
      "nodrail.machine": "a".repeat(32),
      "nodrail.host": "claude-code",
      "nodrail.run": runRef("acme/feature-x"),
      "nodrail.run.event": "step.finished",
      "nodrail.agent": "qa",
      "nodrail.step": "agent-1",
      "nodrail.verdict": "fail",
      "nodrail.findings": "2",
      "nodrail.usage.tokens": "1200",
      "nodrail.usage.usd": "0.04",
    });
    expect(JSON.stringify(reported)).not.toContain("feature-x");
    expect(reported.end).toBe(
      String(Date.parse("2026-11-20T10:00:00.000Z") * 1e6),
    );
  });

  test("an action, and a step start with no usage known", () => {
    const action = runEventSpan({
      run: "r",
      host: "codex",
      machine: "b".repeat(32),
      event: {
        type: "action",
        step: null,
        agent: "main",
        at: "2026-11-20T10:00:00.000Z",
        tool: "github",
        operation: "pulls.merge",
        outcome: "deny",
      },
    });
    expect(action.attributes).toMatchObject({
      "nodrail.tool": "github",
      "nodrail.operation": "pulls.merge",
      "nodrail.outcome": "deny",
      "nodrail.change": "false",
    });
    expect(action.attributes["nodrail.step"]).toBeUndefined();
    const started = runEventSpan({
      run: "r",
      host: "codex",
      machine: "b".repeat(32),
      event: {
        type: "step.started",
        step: "s",
        agent: "qa",
        at: "2026-11-20T10:00:00.000Z",
      },
    });
    expect(started.attributes["nodrail.usage.tokens"]).toBeUndefined();
  });

  test("the policy revision is the file's full digest", () => {
    const home = mkdtempSync(join(tmpdir(), "nodrail-home-"));
    const file = join(home, "effective.yaml");
    writeFileSync(file, "version: 1\n");
    expect(policyRevision([file])).toBe(
      createHash("sha256").update("version: 1\n").digest("hex"),
    );
    expect(policyRevision([home])).toBeNull();
    expect(policyRevision([file, file])).toBeNull();
  });
});

describe("the run hook reports what the ledger records", () => {
  // A folder of the test's own: never a shared name in the temp dir.
  const cwd = mkdtempSync(join(tmpdir(), "nodrail-cwd-"));
  const rules = compilePolicies([
    {
      name: "rules.yaml",
      text: "- rule: Status\n  command: { prefix: git status }\n  effect: allow\n",
    },
  ]);
  if (!rules.ok) throw new Error("the test's rules don't compile");
  const { document } = rules;
  const options = (report: (run: string, event: RunEvent) => void) => ({
    document,
    now: new Date("2026-11-20T10:00:00.000Z"),
    unmatched: "deny" as const,
    report,
  });
  const env = () => ({
    NODRAIL_RUN: "release-42",
    NODRAIL_LEDGER: mkdtempSync(join(tmpdir(), "nodrail-ledger-")),
  });

  test("a step's start and an action, after the ledger has them", () => {
    const told: [string, RunEvent][] = [];
    const where = env();
    const report = (run: string, event: RunEvent) => told.push([run, event]);
    runHook(
      JSON.stringify({
        hook_event_name: "SubagentStart",
        agent_id: "s1",
        agent_type: "qa",
        cwd,
      }),
      options(report),
      where,
    );
    runHook(
      JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "git status" },
        cwd,
      }),
      options(report),
      where,
    );
    expect(told.map(([run, event]) => [run, event.type])).toEqual([
      ["release-42", "step.started"],
      ["release-42", "action"],
    ]);
  });

  test("a reporter that fails changes nothing", () => {
    const result = runHook(
      JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "git status" },
        cwd,
      }),
      options(() => {
        throw new Error("telemetry down");
      }),
      env(),
    );
    expect(result).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  });
});
