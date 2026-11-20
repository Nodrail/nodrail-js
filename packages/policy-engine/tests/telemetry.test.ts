// Nodrail's decisions over OpenTelemetry: one span per decision, with only
// identifiers and the outcome, queued by the hook and sent by a separate
// process, so a receiver that is down never touches a decision.
import { createServer, type IncomingMessage } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { encodeSpans, type SpanRecord } from "../src/otlp";
import {
  decisionSpan,
  enqueue,
  readStatus,
  sendSpool,
  spoolFolder,
  wakeSender,
} from "../src/telemetry";
import { telemetryObserver } from "../src/hook-telemetry";
import { hasSecret, secretName, secretValue } from "../src/secret-refs";
import { cli } from "./run-cli.ts";

/**
 * Makes `home` the person's home (HOME on Unix, USERPROFILE on Windows,
 * which `os.homedir()` reads there). Answers what puts it back.
 */
function homeAt(home: string) {
  const saved = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
  };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return () => {
    for (const [name, value] of Object.entries(saved))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  };
}

const MARKER = "zebra-marker-5512";

const span = (extra: Partial<SpanRecord> = {}): SpanRecord => ({
  traceId: "0af7651916cd43dd8448eb211c80319c",
  spanId: "b7ad6b7169203331",
  name: "nodrail.decision",
  start: "1763424000000000000",
  end: "1763424000001000000",
  attributes: { "nodrail.decision": "deny", "nodrail.agent": "marketing" },
  ...extra,
});

/** A protobuf reader for the test: each field by number, nested where asked. */
function fields(bytes: Uint8Array) {
  const found: { field: number; wire: number; value: Uint8Array | bigint }[] =
    [];
  let at = 0;
  const varint = () => {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      const byte = bytes[at++]!;
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7n;
    }
  };
  while (at < bytes.length) {
    const key = Number(varint());
    const [field, wire] = [key >> 3, key & 7];
    if (wire === 0) found.push({ field, wire, value: varint() });
    else if (wire === 1) {
      let value = 0n;
      for (let index = 7; index >= 0; index--)
        value = (value << 8n) | BigInt(bytes[at + index]!);
      at += 8;
      found.push({ field, wire, value });
    } else {
      const length = Number(varint());
      found.push({ field, wire, value: bytes.slice(at, at + length) });
      at += length;
    }
  }
  return found;
}
const one = (bytes: Uint8Array, field: number) =>
  fields(bytes).find((each) => each.field === field)!.value as Uint8Array;
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe("OTLP bodies", () => {
  test("protobuf is an ExportTraceServiceRequest with the span's fields", () => {
    const { body, contentType } = encodeSpans(
      [span()],
      { "service.name": "nodrail" },
      "otlp-http/protobuf",
    );
    expect(contentType).toBe("application/x-protobuf");
    const resourceSpans = one(body, 1);
    const resourceAttribute = one(one(resourceSpans, 1), 1);
    expect(text(one(resourceAttribute, 1))).toBe("service.name");
    expect(text(one(one(resourceAttribute, 2), 1))).toBe("nodrail");
    const scopeSpans = one(resourceSpans, 2);
    expect(text(one(one(scopeSpans, 1), 1))).toBe("nodrail");
    const encoded = fields(one(scopeSpans, 2));
    const get = (field: number) =>
      encoded.find((each) => each.field === field)!.value;
    expect(Buffer.from(get(1) as Uint8Array).toString("hex")).toBe(
      span().traceId,
    );
    expect(Buffer.from(get(2) as Uint8Array).toString("hex")).toBe(
      span().spanId,
    );
    expect(text(get(5) as Uint8Array)).toBe("nodrail.decision");
    expect(get(6)).toBe(1n);
    expect(get(7)).toBe(1763424000000000000n);
    expect(get(8)).toBe(1763424000001000000n);
    const attributes = encoded
      .filter((each) => each.field === 9)
      .map((each) => [
        text(one(each.value as Uint8Array, 1)),
        text(one(one(each.value as Uint8Array, 2), 1)),
      ]);
    expect(Object.fromEntries(attributes)).toEqual(span().attributes);
  });

  test("JSON is the same request in OTLP's JSON mapping", () => {
    const { body, contentType } = encodeSpans([span()], {}, "otlp-http/json");
    expect(contentType).toBe("application/json");
    const json = JSON.parse(text(body)) as {
      resourceSpans: { scopeSpans: { spans: Record<string, unknown>[] }[] }[];
    };
    expect(json.resourceSpans[0]!.scopeSpans[0]!.spans[0]).toMatchObject({
      traceId: span().traceId,
      kind: 1,
      startTimeUnixNano: span().start,
      attributes: [
        { key: "nodrail.decision", value: { stringValue: "deny" } },
        { key: "nodrail.agent", value: { stringValue: "marketing" } },
      ],
    });
  });
});

describe("a decision as a span", () => {
  test("carries the host's ids and the decision, and nothing the call said", () => {
    const record = decisionSpan({
      event: {
        session_id: "s-1",
        tool_use_id: "toolu_1",
        tool_name: "mcp__handbook__search",
        tool_input: { collection: "internal", query: MARKER },
      } as never,
      host: "codex",
      agent: "marketing",
      action: {
        tool: "handbook",
        operation: "search",
        resource: { kind: "collection" },
      },
      decision: "deny",
      rule: null,
      revision: "abc",
      started: 1n,
      ended: 2n,
    });
    expect(record.attributes).toEqual({
      "nodrail.host": "codex",
      "nodrail.decision": "deny",
      "nodrail.revision": "abc",
      "nodrail.agent": "marketing",
      "nodrail.tool": "handbook",
      "nodrail.operation": "search",
      "nodrail.resource.kind": "collection",
      "session.id": "s-1",
      "gen_ai.conversation.id": "s-1",
      "gen_ai.tool.call.id": "toolu_1",
      "gen_ai.tool.name": "mcp__handbook__search",
    });
    expect(JSON.stringify(record)).not.toContain(MARKER);
    expect(record.traceId).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("the queue", () => {
  const fresh = () => mkdtempSync(join(tmpdir(), "nodrail-spool-"));

  test("is bounded: past its size, spans are dropped and counted", () => {
    const folder = fresh();
    const big = span({ attributes: { pad: "x".repeat(4000) } });
    for (let index = 0; index < 140; index++) enqueue(folder, big);
    expect(
      readFileSync(join(folder, "spool.jsonl")).length,
    ).toBeLessThanOrEqual(512 * 1024);
    expect(readFileSync(join(folder, "dropped")).length).toBeGreaterThan(0);
  });

  test("wakes one sender at a time, takes over a stale one, and waits after a failure", () => {
    const folder = fresh();
    let started = 0;
    const start = () => void started++;
    expect(wakeSender(folder, start)).toBe(true);
    expect(wakeSender(folder, start)).toBe(false);
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(folder, "sending"), old, old);
    expect(wakeSender(folder, start)).toBe(true);
    expect(started).toBe(2);
    const other = fresh();
    writeFileSync(
      join(other, "status.json"),
      JSON.stringify({ retryAfter: Date.now() + 10_000 }),
    );
    expect(wakeSender(other, start)).toBe(false);
  });

  test("lives in the person's home, by the project's real path", () => {
    const project = mkdtempSync(join(tmpdir(), "nodrail-project-"));
    mkdirSync(join(project, ".nodrail"));
    writeFileSync(join(project, ".nodrail/telemetry.json"), "{}");
    expect(
      spoolFolder("/home/x", join(project, ".nodrail/telemetry.json")),
    ).toBe(
      spoolFolder("/home/x", join(project, "sub/../.nodrail/telemetry.json")),
    );
    const folder = spoolFolder("/home/x", "/a/.nodrail/telemetry.json");
    expect(dirname(folder)).toBe(join("/home/x", ".nodrail", "telemetry"));
    expect(basename(folder)).toMatch(/^[0-9a-f]{16}$/);
  });
});

/** A receiver that records each request, answering with `status`. */
function receiver() {
  const got: { path: string; type: string; auth: string; body: Buffer }[] = [];
  let status = 200;
  const server = createServer(async (req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    got.push({
      path: req.url ?? "",
      type: String(req.headers["content-type"]),
      auth: String(req.headers.authorization),
      body: Buffer.concat(chunks),
    });
    res.writeHead(status).end();
  });
  return {
    got,
    fail: (code: number) => void (status = code),
    start: () =>
      new Promise<string>((done) =>
        server.listen(0, "127.0.0.1", () => {
          const address = server.address() as { port: number };
          done(`http://127.0.0.1:${address.port}/v1/traces`);
        }),
      ),
    stop: () => new Promise((done) => server.close(done)),
  };
}

describe("sending", () => {
  const otlp = receiver();
  let endpoint = "";
  beforeAll(async () => void (endpoint = await otlp.start()));
  afterAll(() => otlp.stop());

  const setup = (protocol = "otlp-http/protobuf") => {
    const root = mkdtempSync(join(tmpdir(), "nodrail-telemetry-"));
    mkdirSync(join(root, ".nodrail"));
    const file = join(root, ".nodrail/telemetry.json");
    writeFileSync(
      file,
      JSON.stringify({
        project: "desk",
        traces: {
          endpoint,
          protocol,
          headers: { authorization: { fromEnv: "OTLP_TOKEN" } },
        },
      }),
    );
    const folder = mkdtempSync(join(tmpdir(), "nodrail-spool-"));
    writeFileSync(join(folder, "sending"), "1");
    return { file, folder };
  };

  test("sends what waits, with its header secret, then records it and frees the lock", async () => {
    const { file, folder } = setup();
    enqueue(folder, span());
    enqueue(folder, span());
    const before = otlp.got.length;
    await sendSpool(folder, file, { OTLP_TOKEN: "Bearer t0k3n" });
    const request = otlp.got[before]!;
    expect(request).toMatchObject({
      path: "/v1/traces",
      type: "application/x-protobuf",
      auth: "Bearer t0k3n",
    });
    expect(readStatus(folder)).toMatchObject({
      state: "ok",
      sent: 2,
      dropped: 0,
    });
    expect(readFileSync(join(folder, "status.json"), "utf8")).not.toContain(
      "t0k3n",
    );
    expect(readdirSync(folder).sort()).toEqual(["status.json"]);
  });

  test("a receiver that fails leaves the spans waiting and says so", async () => {
    const { file, folder } = setup("otlp-http/json");
    enqueue(folder, span());
    otlp.fail(503);
    await sendSpool(folder, file, { OTLP_TOKEN: "x" });
    otlp.fail(200);
    const status = readStatus(folder)!;
    expect(status).toMatchObject({
      state: "degraded",
      error: "the receiver answered 503",
    });
    expect(status.retryAfter).toBeGreaterThan(Date.now());
    expect(
      readdirSync(folder).filter((name) => name.startsWith("batch-")),
    ).toHaveLength(1);
    expect(existsSync(join(folder, "sending"))).toBe(false);
  });

  test("a missing header secret degrades sending, naming it", async () => {
    const { file, folder } = setup();
    enqueue(folder, span());
    await sendSpool(folder, file, {});
    expect(readStatus(folder)).toMatchObject({
      state: "degraded",
      error: "OTLP_TOKEN isn't set",
    });
  });

  test("the hook queues each decision and its sender delivers it", async () => {
    const { file } = setup("otlp-http/json");
    const home = mkdtempSync(join(tmpdir(), "nodrail-home-"));
    const rules = join(home, "rules.yaml");
    writeFileSync(
      rules,
      `- rule: Public handbook
  tool: claude-code
  operation: read
  resource: { kind: file, match: any }
  effect: allow
`,
    );
    const before = otlp.got.length;
    const restoreHome = homeAt(home);
    process.env.OTLP_TOKEN = "Bearer z";
    try {
      const result = await cli(
        ["hook", rules, "--telemetry", file, "--agent", "marketing"],
        JSON.stringify({
          hook_event_name: "PreToolUse",
          session_id: "s-9",
          tool_use_id: "toolu_9",
          tool_name: "mcp__handbook__search",
          tool_input: { collection: "internal", query: MARKER },
        }),
      );
      expect(result.stdout).toContain('"deny"');
    } finally {
      restoreHome();
      delete process.env.OTLP_TOKEN;
    }
    // The detached sender delivers it within moments.
    for (let wait = 0; wait < 100 && otlp.got.length === before; wait++)
      await new Promise((done) => setTimeout(done, 100));
    const body = otlp.got[before]!.body.toString();
    expect(body).toContain('"gen_ai.tool.call.id"');
    expect(body).toContain("toolu_9");
    expect(body).not.toContain(MARKER);
    // No rule matched; what the host got was a deny.
    expect(body).toContain(
      '{"key":"nodrail.decision","value":{"stringValue":"deny"}}',
    );
    expect(body).toContain(
      '{"key":"nodrail.match","value":{"stringValue":"none"}}',
    );
  }, 20_000);
});

describe("what can go wrong around sending", () => {
  const fresh = () => mkdtempSync(join(tmpdir(), "nodrail-spool-"));

  test("a sender that can't start frees the lock", () => {
    const folder = fresh();
    expect(() =>
      wakeSender(folder, () => {
        throw new Error("no node");
      }),
    ).toThrow("no node");
    expect(existsSync(join(folder, "sending"))).toBe(false);
    expect(wakeSender(folder, () => undefined)).toBe(true);
  });

  test("past the batches it keeps, the oldest are dropped and counted", async () => {
    const folder = fresh();
    for (let index = 0; index < 22; index++)
      writeFileSync(
        join(folder, `batch-${String(index).padStart(3, "0")}.jsonl`),
        `${JSON.stringify(span())}\n${JSON.stringify(span())}\n`,
      );
    const file = join(fresh(), "telemetry.json");
    writeFileSync(
      file,
      JSON.stringify({
        project: "p",
        traces: { endpoint: "http://127.0.0.1:9/v1/traces" },
      }),
    );
    await sendSpool(
      folder,
      file,
      {},
      async () => new Response(null, { status: 500 }),
    );
    expect(readStatus(folder)).toMatchObject({ state: "degraded", dropped: 4 });
    expect(
      readdirSync(folder).filter((name) => name.startsWith("batch-")),
    ).toHaveLength(20);
    expect(existsSync(join(folder, "batch-000.jsonl"))).toBe(false);
  });
});

describe("the hook's observer", () => {
  const judged = (stdout: string) => ({
    result: { stdout, stderr: "", exitCode: 0 },
    action: null,
    decision: null,
  });

  test("a telemetry file that can't be read turns telemetry off, with a warning", () => {
    const warnings: string[] = [];
    const observer = telemetryObserver({
      file: join(tmpdir(), "missing-telemetry.json"),
      host: "claude-code",
      document: { version: 1, rules: [] } as never,
      self: [],
      warn: (text) => warnings.push(text),
    });
    expect(observer).toBeNull();
    expect(warnings[0]).toContain("Nodrail: telemetry is off: can't read");
  });

  test("records what the host was told, and a failure only warns", () => {
    const home = mkdtempSync(join(tmpdir(), "nodrail-home-"));
    const project = mkdtempSync(join(tmpdir(), "nodrail-project-"));
    const file = join(project, "telemetry.json");
    writeFileSync(
      file,
      JSON.stringify({
        project: "p",
        traces: { endpoint: "http://127.0.0.1:9/v1/traces" },
      }),
    );
    const restoreHome = homeAt(home);
    const warnings: string[] = [];
    try {
      const observer = telemetryObserver({
        file,
        host: "codex",
        document: { version: 1, rules: [] } as never,
        self: [],
        warn: (text) => warnings.push(text),
      })!;
      const folder = spoolFolder(home, file);
      // No sender is started: the last failure is too recent.
      mkdirSync(folder, { recursive: true });
      writeFileSync(
        join(folder, "status.json"),
        JSON.stringify({ retryAfter: Date.now() + 60_000 }),
      );
      const ask = JSON.stringify({
        hookSpecificOutput: { permissionDecision: "ask" },
      });
      for (const stdout of ["", ask, "not json"])
        observer.observe({ judged: judged(stdout), event: null, agent: null });
      const told = readFileSync(join(folder, "spool.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map(
          (line) =>
            (JSON.parse(line) as SpanRecord).attributes["nodrail.decision"],
        );
      expect(told).toEqual(["allow", "require_approval", "deny"]);
      // The queue can't be written: the decision stands, with a warning.
      rmSync(folder, { recursive: true });
      writeFileSync(folder, "");
      observer.observe({ judged: judged(""), event: null, agent: null });
      expect(warnings[0]).toContain("Nodrail: telemetry failed");
    } finally {
      restoreHome();
    }
  });
});

describe("secret references", () => {
  test("from the environment: named, checked and read, never shown", () => {
    const ref = { fromEnv: "OTLP_TOKEN" };
    expect(secretName(ref)).toBe("OTLP_TOKEN");
    expect(hasSecret(ref, { OTLP_TOKEN: "v" })).toBe(true);
    expect(hasSecret(ref, { OTLP_TOKEN: "" })).toBe(false);
    expect(secretValue(ref, { OTLP_TOKEN: "v" })).toBe("v");
    expect(() => secretValue(ref, {})).toThrow("OTLP_TOKEN isn't set");
  });

  test("from the Keychain: named by service and account; absent is an error naming it", () => {
    const ref = {
      fromKeychain: {
        service: `nodrail-test-${process.pid}`,
        account: "nobody",
      },
    };
    expect(secretName(ref)).toBe(`Keychain nodrail-test-${process.pid}/nobody`);
    expect(secretName({ fromKeychain: { service: "s" } })).toBe("Keychain s");
    expect(hasSecret(ref, {})).toBe(false);
    expect(() => secretValue(ref, {})).toThrow(
      process.platform === "darwin"
        ? `Keychain nodrail-test-${process.pid}/nobody isn't in the Keychain`
        : "Keychain references work on macOS only",
    );
  });
});
