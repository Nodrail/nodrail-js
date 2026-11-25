// Mediated calls in the run ledger and in budgets. This uses the engine's own
// ledger writer, reader and lock. The fake providers count
// every call they get, so "never reached" is a count of zero, not a claim.
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import { budgetState, type PolicyBudget } from "@nodrail/policy-engine";
import { fingerprint } from "@nodrail/policy-engine/protocol";
import { describe, expect, test } from "vitest";
import { compileContracts } from "../src/contracts/engine.ts";
import {
  connectionCallEvent,
  ledgerPlace,
  ledgerSink,
  type RunLedger,
} from "../src/connectors/ledger-sink.ts";
import type { Tool, ToolAnswer } from "../src/connectors/mcp-stdio.ts";
import {
  measureResult,
  settledCall,
  settlementOf,
  type SettledCall,
} from "../src/connectors/measure.ts";
import {
  ProviderUnavailable,
  mediateTools,
  recordsFile,
  type CallDetails,
  type MediatedCall,
} from "../src/connectors/mediate.ts";
import { outboxTool } from "../src/connectors/outbox.ts";
import { serveMediated } from "../src/commands/connector.ts";
import {
  readRun,
  record,
  withRunLock,
} from "../../policy-engine/src/ledger.ts";

const compiled = compileContracts({
  manifest: {
    shapes: {
      "refund-args": {
        properties: {
          amount: { type: "integer", min: 1, unit: "usd_cents", report: true },
          api_key: {
            type: "string",
            max: 64,
            classification: "secret",
            optional: true,
          },
        },
      },
      "refund-result": {
        properties: {
          refund_id: { type: "string", max: 64 },
          amount: { type: "integer", min: 0, unit: "usd_cents", report: true },
          fee: {
            type: "object",
            properties: {
              cents: { type: "integer", min: -100000, unit: "usd_cents" },
            },
          },
          tip: { type: "integer", min: 0, optional: true },
          hidden: { type: "integer", min: 0, classification: "secret" },
          note: { type: "string", max: 20 },
        },
      },
      "publish-args": {
        properties: {
          channel: { type: "string", max: 64, report: true },
          text: { type: "string", max: 1000 },
        },
      },
    },
    connections: {
      stripe: {
        command: "npx",
        operations: {
          refund: { input: "refund-args", output: "refund-result" },
        },
      },
      outbox: {
        command: "nodrail",
        operations: { publish: { input: "publish-args" } },
      },
    },
  },
});
if (!compiled.ok) throw new Error(JSON.stringify(compiled.issues));
const contracts = compiled.contracts!;
const refundShape = contracts.shapes["refund-result"]!.shape;

const AT = "2026-11-21T10:00:00.000Z";
const SECRET = "sk_live_DO_NOT_LEAK_4242";
const goodArgs = { amount: 4200, api_key: SECRET };
const goodResult = {
  refund_id: "re_1",
  amount: 4200,
  fee: { cents: 30 },
  hidden: 7,
  note: "ok",
};
const json = (value: unknown): ToolAnswer => ({ text: JSON.stringify(value) });

const engineLedger: RunLedger = { record, withRunLock };

function freshLedger() {
  const root = mkdtempSync(join(tmpdir(), "nodrail-ledger-"));
  const env = { NODRAIL_LEDGER: join(root, "runs"), NODRAIL_RUN: "run-k" };
  return { root, env, place: ledgerPlace(root, env)! };
}

/** A provider whose every call is counted before it answers. */
function countingProvider(
  answer: (args: Record<string, unknown>) => ToolAnswer,
) {
  const calls: Record<string, unknown>[] = [];
  const tool: Tool = {
    name: "refund",
    description: "refund",
    inputSchema: { type: "object" },
    call: async (args) => {
      calls.push(args);
      return answer(args);
    },
  };
  return { calls, tool };
}

function stripe(
  answer: (args: Record<string, unknown>) => ToolAnswer,
  settle?: (call: SettledCall) => void,
) {
  const ledger = freshLedger();
  const provider = countingProvider(answer);
  const details: CallDetails[] = [];
  const [tool] = mediateTools([provider.tool], {
    connection: "stripe",
    contracts,
    sums: [
      { connection: "stripe", operation: "refund", path: "result.amount" },
      { connection: "stripe", operation: "other", path: "result.amount" },
    ],
    record: [
      ledgerSink({ ledger: engineLedger, place: ledger.place, settle }),
      (_call, each) => details.push(each),
    ],
    warn: (message) => {
      throw new Error(message);
    },
    now: () => new Date(AT),
  });
  const events = () => readRun(ledger.place.directory, ledger.place.run);
  return { ...provider, ...ledger, details, events, call: tool!.call };
}

describe("the ledger sink", () => {
  test("each call is a connection.call event in the run, wrapping the record", async () => {
    const run = stripe(() => json(goodResult));
    await run.call(goodArgs);
    const [event] = run.events();
    expect(event).toMatchObject({
      type: "connection.call",
      step: null,
      agent: "main",
      at: AT,
      call: {
        type: "connection.call",
        connection: "stripe",
        operation: "refund",
        execution: "succeeded",
        delivered: true,
        input: { state: "valid", values: { amount: 4200 } },
        result: { state: "valid" },
      },
    });
    expect(JSON.stringify(run.events())).not.toContain(SECRET);
  });

  test("sinks see the hook's input digest for the exact arguments", async () => {
    const run = stripe(() => json(goodResult));
    await run.call(goodArgs);
    expect(run.details[0]!.input_sha256).toBe(fingerprint(goodArgs));
    expect(run.details[0]!.input_sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    // Key order doesn't change it: the digest is of the canonical form.
    expect(fingerprint({ api_key: SECRET, amount: 4200 })).toBe(
      run.details[0]!.input_sha256,
    );
  });

  test("the event is written and settled inside the run's lock", () => {
    const steps: string[] = [];
    const ledger: RunLedger = {
      record: () => steps.push("record"),
      withRunLock: (_directory, run, work) => {
        steps.push(`lock ${run}`);
        try {
          return work();
        } finally {
          steps.push("unlock");
        }
      },
    };
    const sink = ledgerSink({
      ledger,
      place: { directory: "/nowhere", run: "r" },
      settle: () => steps.push("settle"),
    });
    sink(call("succeeded"), { input_sha256: "sha256:x", measured: [] });
    expect(steps).toEqual(["lock r", "record", "settle", "unlock"]);
  });

  test("with no run to join, nothing is written and nothing throws", () => {
    let touched = false;
    const sink = ledgerSink({
      ledger: {
        record: () => (touched = true),
        withRunLock: () => (touched = true) as never,
      },
      place: null,
    });
    sink(call("succeeded"), { input_sha256: "sha256:x", measured: [] });
    expect(touched).toBe(false);
  });

  test("the run is NODRAIL_RUN's, in the ledger NODRAIL_LEDGER names", () => {
    const { root, env } = freshLedger();
    expect(ledgerPlace(root, env)).toEqual({
      directory: env.NODRAIL_LEDGER,
      run: "run-k",
    });
    // Outside git, no NODRAIL_RUN and no session: no run to join.
    expect(ledgerPlace(root, { HOME: root })).toBeNull();
  });

  test("a ledger that refuses the event is reported, and the answer and other sinks are kept", async () => {
    const warnings: string[] = [];
    const folder = join(mkdtempSync(join(tmpdir(), "nodrail-rec-")), "r");
    const provider = countingProvider(() => json(goodResult));
    const [tool] = mediateTools([provider.tool], {
      connection: "stripe",
      contracts,
      record: [
        ledgerSink({
          ledger: {
            record,
            withRunLock: () => {
              throw new Error('Run "r" is busy');
            },
          },
          place: { directory: folder, run: "r" },
        }),
        recordsFile(folder),
      ],
      warn: (message) => warnings.push(message),
    });
    const answer = await tool!.call(goodArgs);
    expect(JSON.parse(answer.text)).toMatchObject({ refund_id: "re_1" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('couldn\'t be kept: Run "r" is busy');
    expect(existsSync(join(folder, "calls.jsonl"))).toBe(true);
  });

  test("the event is the engine's: its writer rejects one that breaks the schema", () => {
    const { place } = freshLedger();
    const bad = connectionCallEvent({
      ...call("succeeded"),
      connection: "Not A Connection",
    });
    expect(() =>
      withRunLock(place.directory, place.run, () =>
        record(place.directory, place.run, bad),
      ),
    ).toThrow();
    expect(readRun(place.directory, place.run)).toEqual([]);
  });
});

describe("a refused call never reaches the provider", () => {
  test("invalid input: zero provider calls, recorded not-called, released", async () => {
    const settled: SettledCall[] = [];
    const run = stripe(
      () => json(goodResult),
      (each) => settled.push(each),
    );
    const answer = await run.call({ amount: 0, extra: SECRET });
    expect(run.calls).toHaveLength(0);
    expect(answer.isError).toBe(true);
    const [event] = run.events();
    expect(event).toMatchObject({
      type: "connection.call",
      call: { execution: "not-called", input: { state: "invalid" } },
    });
    expect(settled).toEqual([
      expect.objectContaining({ settlement: "released", measured: [] }),
    ]);
    expect(JSON.stringify(run.events())).not.toContain(SECRET);
  });

  test("input over 16 KiB is refused by the engine's checkInput, zero calls", async () => {
    const run = stripe(() => json(goodResult));
    await run.call({ amount: 1, api_key: "k".repeat(17 * 1024) });
    expect(run.calls).toHaveLength(0);
    expect(run.events()[0]).toMatchObject({
      call: { input: { issues: [{ path: "(value)", code: "size" }] } },
    });
  });

  test("the outbox's fourth publication (limit 3) is denied before it is reached", async () => {
    const { root, place } = freshLedger();
    const folder = join(root, "outbox");
    const outbox = outboxTool(folder);
    let reached = 0;
    const counted: Tool = {
      ...outbox,
      call: async (args) => {
        reached += 1;
        return outbox.call(args);
      },
    };
    const [publish] = mediateTools([counted], {
      connection: "outbox",
      contracts,
      record: ledgerSink({ ledger: engineLedger, place }),
      warn: (message) => {
        throw new Error(message);
      },
    });
    // Today's engine budget, counted from the run ledger under its lock, as
    // the hook does: tool_calls per run. (Wave 3's `count: {tool,
    // operation}` replaces it; the boundary is the same.)
    const budget: PolicyBudget = {
      id: "publications",
      name: "Publications per run",
      agent: null,
      per: "run",
      metric: "tool_calls",
      limit: 3,
      warnAt: null,
      effect: "deny",
    };
    const hookAllows = () =>
      withRunLock(place.directory, place.run, () => {
        const events = readRun(place.directory, place.run);
        const state = budgetState(budget, {
          run: place.run,
          step: null,
          events,
        });
        const allowed = state?.state !== "over";
        record(place.directory, place.run, {
          type: "action",
          step: null,
          agent: "main",
          at: AT,
          tool: "outbox",
          operation: "publish",
          outcome: allowed ? "allow" : "deny",
        });
        return allowed;
      });
    const outcomes: string[] = [];
    for (let index = 1; index <= 4; index += 1) {
      if (!hookAllows()) {
        outcomes.push("denied");
        continue;
      }
      const answer = await publish!.call({
        channel: "blog",
        text: `post ${index}`,
      });
      outcomes.push(answer.isError ? "error" : "published");
    }
    expect(outcomes).toEqual(["published", "published", "published", "denied"]);
    expect(reached).toBe(3);
    expect(readdirSync(join(folder, "blog"))).toHaveLength(3);
    const calls = readRun(place.directory, place.run).filter(
      (event) => event.type === "connection.call",
    );
    expect(calls).toHaveLength(3);
  });
});

describe("settlement", () => {
  /** One refund through a provider answering so; it reaches the provider once. */
  async function refundOnce(answer: Parameters<typeof stripe>[0]) {
    const settled: SettledCall[] = [];
    const run = stripe(answer, (each) => settled.push(each));
    await run.call(goodArgs);
    expect(run.calls).toHaveLength(1);
    return { run, settled };
  }

  test("a provider failure releases; the call reached it once", async () => {
    const { settled } = await refundOnce(() => ({
      text: "card_declined",
      isError: true,
    }));
    expect(settled[0]).toMatchObject({
      settlement: "released",
      connection: "stripe",
      operation: "refund",
      input_sha256: fingerprint(goodArgs),
      measured: [],
    });
  });

  test("a provider that stops answering keeps the reservation as unknown", async () => {
    const { run, settled } = await refundOnce(() => {
      throw new Error("socket hang up");
    });
    expect(settled[0]).toMatchObject({ settlement: "unknown", measured: [] });
    expect(run.events()[0]).toMatchObject({ call: { execution: "unknown" } });
  });

  test("a provider that never got the call releases", async () => {
    const settled: SettledCall[] = [];
    const ledger = freshLedger();
    const [tool] = mediateTools(
      [
        {
          name: "refund",
          description: "refund",
          inputSchema: { type: "object" },
          call: () => Promise.reject(new ProviderUnavailable("exited")),
        },
      ],
      {
        connection: "stripe",
        contracts,
        record: ledgerSink({
          ledger: engineLedger,
          place: ledger.place,
          settle: (each) => settled.push(each),
        }),
      },
    );
    await tool!.call(goodArgs);
    expect(settled[0]!.settlement).toBe("released");
  });

  test("a success is consumed, with the summed result amount", async () => {
    const settled: SettledCall[] = [];
    const run = stripe(
      () => json(goodResult),
      (each) => settled.push(each),
    );
    await run.call(goodArgs);
    expect(settled[0]).toMatchObject({
      settlement: "consumed",
      measured: [{ path: "result.amount", value: 4200, gap: null }],
    });
  });

  test("a success whose result is withheld is consumed, its amount unknown", async () => {
    const settled: SettledCall[] = [];
    const run = stripe(
      () => json({ ...goodResult, note: "x".repeat(50) }),
      (each) => settled.push(each),
    );
    const answer = await run.call(goodArgs);
    expect(answer.isError).toBe(true);
    expect(run.calls).toHaveLength(1);
    expect(settled[0]).toMatchObject({
      settlement: "consumed",
      measured: [{ path: "result.amount", value: null, gap: "no-result" }],
    });
  });

  test("each execution settles one way", () => {
    expect(settlementOf("succeeded")).toBe("consumed");
    expect(settlementOf("failed")).toBe("released");
    expect(settlementOf("not-called")).toBe("released");
    expect(settlementOf("unknown")).toBe("unknown");
    const measured = [{ path: "result.amount", value: 1, gap: null } as const];
    expect(
      settledCall(call("failed"), { input_sha256: "sha256:x", measured })
        .measured,
    ).toEqual([]);
  });
});

describe("measuring result amounts", () => {
  const measure = (paths: string[], result: unknown) =>
    measureResult(
      paths.map((path) => ({
        connection: "stripe",
        operation: "refund",
        path,
      })),
      { connection: "stripe", operation: "refund", shape: refundShape, result },
    );

  test("reads declared integer paths, nested too", () => {
    expect(measure(["result.amount", "result.fee.cents"], goodResult)).toEqual([
      { path: "result.amount", value: 4200, gap: null },
      { path: "result.fee.cents", value: 30, gap: null },
    ]);
  });

  test("only unclassified integers the output declares can be summed", () => {
    expect(
      measure(
        [
          "result.note",
          "result.hidden",
          "result.nothing",
          "result.fee",
          "input.amount",
          "result.amount.more",
          "amount",
        ],
        goodResult,
      ).map((reading) => reading.gap),
    ).toEqual(Array(7).fill("undeclared"));
    // No declared output: nothing to read against.
    expect(
      measureResult(
        [{ connection: "stripe", operation: "refund", path: "result.amount" }],
        {
          connection: "stripe",
          operation: "refund",
          shape: null,
          result: goodResult,
        },
      )[0]!.gap,
    ).toBe("undeclared");
  });

  test("a missing, negative or unsafe value is a gap, never 0", () => {
    expect(measure(["result.tip"], goodResult)[0]).toEqual({
      path: "result.tip",
      value: null,
      gap: "missing",
    });
    expect(
      measure(["result.fee.cents"], { ...goodResult, fee: { cents: -5 } })[0]!
        .gap,
    ).toBe("not-integer");
    expect(
      measure(["result.amount"], { ...goodResult, amount: 2 ** 60 })[0]!.gap,
    ).toBe("not-integer");
    expect(measure(["result.amount"], undefined)[0]!.gap).toBe("no-result");
  });

  test("sums of other operations or connections are ignored", () => {
    expect(
      measureResult(
        [{ connection: "github", operation: "refund", path: "result.amount" }],
        {
          connection: "stripe",
          operation: "refund",
          shape: refundShape,
          result: goodResult,
        },
      ),
    ).toEqual([]);
  });
});

function call(execution: MediatedCall["execution"]): MediatedCall {
  return {
    type: "connection.call",
    event: "6f1c4b8e-2a7d-4c1e-9b3a-0d5e8f7a6c21",
    connection: "stripe",
    operation: "refund",
    occurred_at: AT,
    producer: { class: "runtime-observed", id: "connector:stripe" },
    input: null,
    execution,
    result: null,
    delivered: execution === "succeeded",
  };
}

describe("nodrail connection run", () => {
  test("a mediated connection's calls join the run ledger the hooks use", async () => {
    const { root, env, place } = freshLedger();
    Object.assign(process.env, env);
    try {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const served = serveMediated({
        connection: "outbox",
        command: "nodrail",
        args: ["connector", "outbox", "--folder", "./out"],
        env: {},
        root,
        contracts,
        version: "0.0.0-test",
        stdin,
        stdout,
      });
      const answered = new Promise<string>((resolve) =>
        stdout.on("data", (chunk: Buffer) => resolve(chunk.toString("utf8"))),
      );
      stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "publish", arguments: { channel: "blog", text: "hello" } } })}\n`,
      );
      expect(await answered).toContain('"id":1');
      stdin.end();
      await served;
      expect(
        readRun(place.directory, place.run).map((event) => event.type),
      ).toEqual(["connection.call"]);
    } finally {
      delete process.env.NODRAIL_LEDGER;
      delete process.env.NODRAIL_RUN;
    }
  });
});
