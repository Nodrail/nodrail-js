// Mediated connections (preview): input is
// checked before the provider is called, a result after it returns, and the
// two are recorded apart. Fake providers only: each counts its calls, so a
// refused call is proven to reach it zero times and an invalid result once.
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import { compileContracts } from "../src/contracts/engine.ts";
import {
  connectUpstream,
  serveMediatedProxy,
} from "../src/connectors/mcp-proxy.ts";
import type { Tool, ToolAnswer } from "../src/connectors/mcp-stdio.ts";
import {
  connectionContracts,
  mediateTools,
  recordsFile,
  type MediatedCall,
} from "../src/connectors/mediate.ts";

const SECRET = "sk_live_DO_NOT_LEAK_4242";
const EMAIL = "pat@example.com";

const compiled = compileContracts({
  manifest: {
    shapes: {
      "refund-args": {
        properties: {
          amount: { type: "integer", min: 1, unit: "usd_cents", report: true },
          currency: { values: ["usd", "eur"], report: true },
          customer_email: { type: "string", max: 254, classification: "pii" },
          api_key: {
            type: "string",
            max: 64,
            classification: "secret",
            optional: true,
          },
          reason: { type: "string", max: 200, optional: true },
        },
      },
      "refund-result": {
        properties: {
          refund_id: { type: "string", max: 64 },
          status: { values: ["succeeded", "pending", "failed"], report: true },
          amount: { type: "integer", min: 0, unit: "usd_cents", report: true },
          token: {
            type: "string",
            max: 64,
            classification: "secret",
            optional: true,
          },
        },
      },
    },
    connections: {
      stripe: {
        command: "npx",
        operations: {
          refund: { input: "refund-args", output: "refund-result" },
          list_charges: {},
        },
      },
    },
  },
});
if (!compiled.ok) throw new Error(JSON.stringify(compiled.issues));
const contracts = compiled.contracts!;

const goodArgs = {
  amount: 4200,
  currency: "usd",
  customer_email: EMAIL,
  api_key: SECRET,
};
const goodResult = { refund_id: "re_1", status: "succeeded", amount: 4200 };

/** A provider whose every call is a side effect you can count. */
function fakeProvider(
  answer: (args: Record<string, unknown>) => ToolAnswer | Promise<ToolAnswer>,
) {
  const effects: Record<string, unknown>[] = [];
  const tool = (name: string): Tool => ({
    name,
    description: name,
    inputSchema: { type: "object" },
    call: async (args) => {
      effects.push(args);
      return answer(args);
    },
  });
  return { effects, tools: [tool("refund"), tool("list_charges")] };
}

function mediated(answer: Parameters<typeof fakeProvider>[0]) {
  const provider = fakeProvider(answer);
  const records: MediatedCall[] = [];
  const tools = mediateTools(provider.tools, {
    connection: "stripe",
    contracts,
    record: (call) => records.push(call),
    now: () => new Date("2026-11-21T10:00:00.000Z"),
  });
  const call = (name: string, args: object) =>
    tools
      .find((each) => each.name === name)!
      .call(args as Record<string, unknown>);
  return { ...provider, records, call };
}

const json = (value: unknown): ToolAnswer => ({ text: JSON.stringify(value) });

describe("declared slots", () => {
  test("each operation's input and output come from the compiled bindings", () => {
    const slots = connectionContracts(contracts, "stripe");
    expect([...slots.keys()]).toEqual(["refund"]);
    expect(slots.get("refund")!.input).toMatchObject({
      binding: "input:stripe.refund",
      surface: "S03",
      shape: "refund-args",
    });
    expect(slots.get("refund")!.output).toMatchObject({
      binding: "output:stripe.refund",
      surface: "S04",
      shape: "refund-result",
    });
    expect(connectionContracts(contracts, "github").size).toBe(0);
    expect(connectionContracts(null, "stripe").size).toBe(0);
  });
});

describe("input, before the provider", () => {
  test("arguments that break the declared input never reach the provider", async () => {
    const run = mediated(() => json(goodResult));
    const answer = await run.call("refund", {
      amount: 0,
      currency: "gbp",
      customer_email: EMAIL,
      api_key: SECRET,
      note: "extra",
    });
    expect(run.effects).toHaveLength(0);
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain("Nothing was sent to the provider");
    expect(answer.text).toContain("amount: below");
    expect(answer.text).toContain("currency: enum");
    expect(answer.text).toContain("note: unknown");
    const [record] = run.records;
    expect(record).toMatchObject({
      type: "connection.call",
      connection: "stripe",
      operation: "refund",
      occurred_at: "2026-11-21T10:00:00.000Z",
      producer: { class: "runtime-observed", id: "connector:stripe" },
      execution: "not-called",
      result: null,
      delivered: false,
      input: {
        surface: "S03",
        name: "input:stripe.refund",
        shape: "refund-args",
        state: "invalid",
        at: "local",
        reason: null,
        values: null,
      },
    });
    expect(record!.input!.contract).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(record!.input!.projection).toMatch(/^sha256:[0-9a-f]{64}$/);
    // Neither the secret, nor the personal data, nor a rejected value.
    for (const leak of [SECRET, EMAIL, "gbp", "extra"]) {
      expect(answer.text).not.toContain(leak);
      expect(JSON.stringify(run.records)).not.toContain(leak);
    }
  });

  test("a missing required argument is refused too", async () => {
    const run = mediated(() => json(goodResult));
    const answer = await run.call("refund", { amount: 10, currency: "usd" });
    expect(run.effects).toHaveLength(0);
    expect(answer.text).toContain("customer_email: required");
  });

  test("arguments over 16 KiB are refused before they are read", async () => {
    const run = mediated(() => json(goodResult));
    const answer = await run.call("refund", {
      ...goodArgs,
      reason: "x".repeat(17 * 1024),
    });
    expect(run.effects).toHaveLength(0);
    expect(answer.isError).toBe(true);
    expect(run.records[0]!.input).toMatchObject({
      state: "invalid",
      issues: [{ path: "(value)", code: "size" }],
    });
  });
});

describe("result, after the provider", () => {
  test("a valid result is delivered, and only the reported fields are recorded", async () => {
    const run = mediated(() => json({ ...goodResult, token: SECRET }));
    const answer = await run.call("refund", goodArgs);
    expect(answer.isError).toBeUndefined();
    expect(JSON.parse(answer.text)).toEqual({ ...goodResult, token: SECRET });
    expect(answer.content).toEqual([{ type: "text", text: answer.text }]);
    expect(run.effects).toHaveLength(1);
    const [record] = run.records;
    expect(record).toMatchObject({
      execution: "succeeded",
      delivered: true,
      input: { state: "valid", values: { amount: 4200, currency: "usd" } },
      result: {
        surface: "S04",
        name: "output:stripe.refund",
        state: "valid",
        issues: [],
        values: { status: "succeeded", amount: 4200 },
      },
    });
    expect(JSON.stringify(record)).not.toContain(SECRET);
    expect(JSON.stringify(record)).not.toContain(EMAIL);
  });

  test("an invalid result is withheld, recorded as run, and never retried", async () => {
    const run = mediated(() =>
      json({
        refund_id: "re_1",
        status: "requires_action",
        amount: 4200,
        token: SECRET,
      }),
    );
    const answer = await run.call("refund", goodArgs);
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain(
      "ran on stripe and the provider reported success",
    );
    expect(answer.text).toContain("status: enum");
    expect(answer.text).toContain("don't call refund again");
    expect(answer.text).not.toContain("requires_action");
    expect(answer.text).not.toContain(SECRET);
    // One side effect: Nodrail called the provider once and stopped.
    expect(run.effects).toHaveLength(1);
    expect(run.records).toHaveLength(1);
    expect(run.records[0]).toMatchObject({
      execution: "succeeded",
      delivered: false,
      result: {
        state: "invalid",
        issues: [{ path: "status", code: "enum" }],
        values: null,
      },
    });
    expect(JSON.stringify(run.records)).not.toContain(SECRET);
  });

  test("a result over 64 KiB is invalid, not parsed and not delivered", async () => {
    const run = mediated(() =>
      json({ ...goodResult, refund_id: "r".repeat(65 * 1024) }),
    );
    const answer = await run.call("refund", goodArgs);
    expect(answer.isError).toBe(true);
    expect(run.effects).toHaveLength(1);
    expect(run.records[0]!.result).toMatchObject({
      state: "invalid",
      issues: [{ path: "(value)", code: "size" }],
    });
  });

  test("an oversized structured result is invalid as well", async () => {
    const run = mediated(() => ({
      text: "",
      structuredContent: { ...goodResult, refund_id: "r".repeat(65 * 1024) },
    }));
    await run.call("refund", goodArgs);
    expect(run.records[0]!.result!.issues).toEqual([
      { path: "(value)", code: "size" },
    ]);
  });

  test("a result Nodrail can't read is unsupported, never valid", async () => {
    const prose = mediated(() => ({ text: "Refund done, all good." }));
    const answer = await prose.call("refund", goodArgs);
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain(
      "can't read its result as one structured value (not-json)",
    );
    expect(prose.records[0]!.result).toMatchObject({
      state: "unsupported",
      reason: "not-json",
      issues: [],
      values: null,
    });
    expect(prose.effects).toHaveLength(1);

    for (const content of [
      [{ type: "image", data: "AAAA", mimeType: "image/png" }],
      [],
      [
        { type: "text", text: "{}" },
        { type: "text", text: "{}" },
      ],
    ]) {
      const odd = mediated(() => ({ text: "", content }));
      const withheld = await odd.call("refund", goodArgs);
      expect(withheld.isError).toBe(true);
      expect(odd.records[0]!.result).toMatchObject({
        state: "unsupported",
        reason: "content-form",
      });
      expect(odd.records[0]!.delivered).toBe(false);
    }
  });

  test("structuredContent is what is checked, and all that is delivered", async () => {
    const run = mediated(() => ({
      text: "Refunded. Card ending 4242.",
      content: [{ type: "text", text: "Refunded. Card ending 4242." }],
      structuredContent: goodResult,
    }));
    const answer = await run.call("refund", goodArgs);
    expect(answer.structuredContent).toEqual(goodResult);
    expect(answer.content).toEqual([
      { type: "text", text: JSON.stringify(goodResult) },
    ]);
    expect(answer.text).not.toContain("4242.");
    expect(run.records[0]!.result!.state).toBe("valid");
  });

  test("a provider error is passed on and recorded as failed, with no result check", async () => {
    const run = mediated(() => ({ text: "card_declined", isError: true }));
    const answer = await run.call("refund", goodArgs);
    expect(answer).toEqual({ text: "card_declined", isError: true });
    expect(run.records[0]).toMatchObject({
      execution: "failed",
      result: null,
      delivered: true,
    });
  });

  test("a provider that stops answering leaves the outcome unknown, and isn't retried", async () => {
    const run = mediated(() => {
      throw new Error(`socket hang up with ${SECRET}`);
    });
    const answer = await run.call("refund", goodArgs);
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain("whether it took effect is unknown");
    expect(answer.text).not.toContain(SECRET);
    expect(run.effects).toHaveLength(1);
    expect(run.records[0]).toMatchObject({
      execution: "unknown",
      result: null,
      delivered: false,
    });
  });

  test("an operation that declares nothing runs as before, recorded with no claim", async () => {
    const run = mediated(() => ({ text: "anything at all" }));
    const answer = await run.call("list_charges", { anything: 1 });
    expect(answer).toEqual({ text: "anything at all" });
    expect(run.records[0]).toMatchObject({
      operation: "list_charges",
      input: null,
      result: null,
      execution: "succeeded",
      delivered: true,
    });
  });
});

describe("records", () => {
  test("a record that can't be kept is reported, and the answer still arrives", async () => {
    const warnings: string[] = [];
    const [tool] = mediateTools(fakeProvider(() => json(goodResult)).tools, {
      connection: "stripe",
      contracts,
      record: () => {
        throw new Error("disk full");
      },
      warn: (message) => warnings.push(message),
    });
    const answer = await tool!.call(goodArgs);
    expect(JSON.parse(answer.text)).toEqual(goodResult);
    expect(warnings[0]).toMatch(
      /record of refund \(event [0-9a-f-]{36}\) couldn't be kept: disk full/,
    );
  });

  test("records go to calls.jsonl, one line per call, each its own event", async () => {
    const folder = join(
      mkdtempSync(join(tmpdir(), "nodrail-calls-")),
      "records",
    );
    const tools = mediateTools(fakeProvider(() => json(goodResult)).tools, {
      connection: "stripe",
      contracts,
      record: recordsFile(folder),
    });
    await tools[0]!.call(goodArgs);
    await tools[0]!.call(goodArgs);
    const lines = readFileSync(join(folder, "calls.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as MediatedCall);
    expect(lines).toHaveLength(2);
    expect(lines[0]!.event).not.toBe(lines[1]!.event);
    expect(lines[0]!.occurred_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

/** A provider's own MCP server: it appends each tools/call to CALLS. */
const PROVIDER = String.raw`
const fs = require("node:fs");
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  if (m.result !== undefined || m.error !== undefined) return;
  if (m.method === "initialize") {
    process.stdout.write("not the protocol\n");
    send({ id: "p1", method: "ping" });
    send({ id: "p2", method: "roots/list" });
    send({ method: "notifications/message", params: {} });
    send({ id: 999, result: {} });
    return send({ id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } });
  }
  if (m.method === "tools/list") {
    if (!m.params.cursor)
      return send({ id: m.id, result: { tools: [{ name: "refund", description: "Refund a charge", inputSchema: { type: "object" }, outputSchema: { type: "object" } }, { nameless: true }], nextCursor: "2" } });
    return send({ id: m.id, result: { tools: [{ name: "crash" }, { name: "slow" }] } });
  }
  if (m.method === "tools/call") {
    fs.appendFileSync(process.env.CALLS, m.params.name + "\n");
    const a = m.params.arguments;
    if (m.params.name === "crash") process.exit(1);
    if (m.params.name === "slow") return;
    const value = { refund_id: "re_1", status: a.reason === "odd" ? "requires_action" : "succeeded", amount: a.amount };
    if (a.reason === "rpc") return send({ id: m.id, error: { code: -32000, message: "declined" } });
    if (a.reason === "structured") return send({ id: m.id, result: { content: [{ type: "text", text: "Refunded." }], structuredContent: value } });
    if (a.reason === "failed") return send({ id: m.id, result: { content: [{ type: "text", text: "card_declined" }], isError: true } });
    return send({ id: m.id, result: { content: [{ type: "text", text: JSON.stringify(value) }] } });
  }
  send({ id: m.id, error: { code: -32601, message: "no" } });
});
`;

function providerFolder() {
  const folder = mkdtempSync(join(tmpdir(), "nodrail-provider-"));
  writeFileSync(join(folder, "provider.cjs"), PROVIDER);
  return { folder, calls: join(folder, "calls.txt") };
}

const countCalls = (file: string) =>
  existsSync(file)
    ? readFileSync(file, "utf8").split("\n").filter(Boolean)
    : [];

/** A host: sends JSON-RPC to the mediated proxy and reads its answers. */
function host(options: { callTimeoutMs?: number } = {}) {
  const { folder, calls } = providerFolder();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const records: MediatedCall[] = [];
  const answers = new Map<number, (message: Record<string, unknown>) => void>();
  let buffer = "";
  stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const message = JSON.parse(buffer.slice(0, newline)) as Record<
        string,
        unknown
      >;
      buffer = buffer.slice(newline + 1);
      answers.get(message.id as number)?.(message);
    }
  });
  const served = serveMediatedProxy({
    name: "nodrail-stripe",
    version: "0.0.0-test",
    upstream: {
      command: process.execPath,
      args: [join(folder, "provider.cjs")],
      env: { CALLS: calls },
      ...(options.callTimeoutMs
        ? { callTimeoutMs: options.callTimeoutMs }
        : {}),
    },
    mediate: {
      connection: "stripe",
      contracts,
      record: (call) => records.push(call),
    },
    stdin,
    stdout,
  });
  let id = 0;
  const send = (method: string, params: object = {}) =>
    new Promise<Record<string, unknown>>((resolve) => {
      const mine = ++id;
      answers.set(mine, resolve);
      stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: mine, method, params })}\n`,
      );
    });
  const call = async (name: string, args: object) =>
    (await send("tools/call", { name, arguments: args })).result as {
      content: { type: string; text: string }[];
      structuredContent?: unknown;
      isError?: boolean;
    };
  const close = async () => {
    stdin.end();
    await served;
  };
  return { send, call, close, records, calls: () => countCalls(calls) };
}

describe("a generic MCP provider behind the proxy", () => {
  test("lists the provider's tools, every page, as the provider declared them", async () => {
    const agent = host();
    const { result } = await agent.send("tools/list");
    expect(
      (result as { tools: { name: string }[] }).tools.map((t) => t.name),
    ).toEqual(["refund", "crash", "slow"]);
    expect((result as { tools: object[] }).tools[0]).toEqual({
      name: "refund",
      description: "Refund a charge",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
    });
    await agent.close();
  });

  test("refused input reaches the provider zero times; a valid call once", async () => {
    const agent = host();
    const refused = await agent.call("refund", {
      amount: -5,
      currency: "usd",
      customer_email: EMAIL,
      api_key: SECRET,
    });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toContain("amount: below");
    expect(refused.content[0]!.text).not.toContain(SECRET);
    expect(agent.calls()).toEqual([]);

    const ok = await agent.call("refund", goodArgs);
    expect(ok.isError).toBeUndefined();
    expect(JSON.parse(ok.content[0]!.text)).toEqual(goodResult);
    expect(agent.calls()).toEqual(["refund"]);
    expect(
      agent.records.map((r) => [r.execution, r.input?.state, r.result?.state]),
    ).toEqual([
      ["not-called", "invalid", undefined],
      ["succeeded", "valid", "valid"],
    ]);
    await agent.close();
  });

  test("an invalid result is withheld after exactly one provider call", async () => {
    const agent = host();
    const answer = await agent.call("refund", { ...goodArgs, reason: "odd" });
    expect(answer.isError).toBe(true);
    expect(answer.content[0]!.text).toContain("status: enum");
    expect(answer.content[0]!.text).not.toContain("requires_action");
    expect(agent.calls()).toEqual(["refund"]);
    expect(agent.records[0]).toMatchObject({
      execution: "succeeded",
      delivered: false,
      result: { state: "invalid" },
    });
    await agent.close();
  });

  test("structured results, provider errors and JSON-RPC errors keep their meaning", async () => {
    const agent = host();
    const structured = await agent.call("refund", {
      ...goodArgs,
      reason: "structured",
    });
    expect(structured.structuredContent).toEqual(goodResult);
    const failed = await agent.call("refund", {
      ...goodArgs,
      reason: "failed",
    });
    expect(failed).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "card_declined" }],
    });
    const rpc = await agent.call("refund", { ...goodArgs, reason: "rpc" });
    expect(rpc.isError).toBe(true);
    expect(rpc.content[0]!.text).toBe(
      "the provider answered error -32000: declined",
    );
    expect(agent.records.map((r) => r.execution)).toEqual([
      "succeeded",
      "failed",
      "failed",
    ]);
    expect(agent.calls()).toHaveLength(3);
    await agent.close();
  });

  test("a provider that times out leaves the outcome unknown, sent once", async () => {
    const agent = host({ callTimeoutMs: 200 });
    const answer = await agent.call("slow", {});
    expect(answer.isError).toBe(true);
    expect(answer.content[0]!.text).toContain(
      "whether it took effect is unknown",
    );
    expect(agent.calls()).toEqual(["slow"]);
    expect(agent.records[0]!.execution).toBe("unknown");
    await agent.close();
  });

  test("a provider that exits mid-call leaves the outcome unknown, and later calls aren't sent", async () => {
    const agent = host();
    const crashed = await agent.call("crash", {});
    expect(crashed.content[0]!.text).toContain(
      "whether it took effect is unknown",
    );
    const after = await agent.call("refund", goodArgs);
    expect(after.isError).toBe(true);
    expect(after.content[0]!.text).toBe(
      "refund wasn't sent: stripe isn't running (the provider exited). Nothing reached the provider.",
    );
    expect(agent.calls()).toEqual(["crash"]);
    expect(agent.records.map((r) => r.execution)).toEqual([
      "unknown",
      "not-called",
    ]);
    await agent.close();
  });

  test("a provider that can't start is reported, never served", async () => {
    await expect(
      connectUpstream({
        command: join(tmpdir(), "no-such-provider-nodrail"),
        args: [],
      }),
    ).rejects.toThrow(
      "The provider didn't start: the provider couldn't be started",
    );
  });
});
