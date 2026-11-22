// Briefs (S02) and connection input/output shapes (S03, S04), Wave 2 in the
// CLI: declared and locked, briefs written into the files of the agents that
// start them, render/validate/explain for both, changes classified, and a
// connection with declared shapes started mediated by `connection run`.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { parse } from "yaml";
import { describe, expect, test } from "vitest";
import { runMediated } from "../src/commands/connection.ts";
import { BRIEF_BEGIN, BRIEF_END, briefOf } from "../src/contracts/brief.ts";
import { contractChanges, lockedContracts } from "../src/contracts/changes.ts";
import { compileContracts, readBrief } from "../src/contracts/engine.ts";
import { CONNECTIONS_FILE } from "../src/setup/connections.ts";
import {
  fileOf,
  leadFiles,
  locked,
  project,
  planFor,
  RESOURCES,
  windows,
} from "./support/setup-project.ts";

const api = "apiVersion: apf.nodrail.com/v1alpha1";

/** A provider as small as MCP allows: `refund`, logging each call it gets. */
const PROVIDER = `const { appendFileSync } = require("node:fs");
const { createInterface } = require("node:readline");
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "pay", version: "1" } } });
  else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: [
    { name: "refund", inputSchema: { type: "object", properties: {} } },
    { name: "list", inputSchema: { type: "object", properties: {} } } ] } });
  else if (m.method === "tools/call") {
    appendFileSync("provider-calls.jsonl", JSON.stringify({ args: m.params.arguments, env: Object.keys(process.env).sort() }) + "\\n");
    const status = m.params.arguments.amount > 1000 ? "strange" : "succeeded";
    send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: JSON.stringify({ status, id: "re_1" }) }] } });
  }
});
`;

const SHAPES = `shapes:
  publish-brief:
    for: What the publisher needs to start
    properties:
      issue: { type: string, max: 40, for: "The issue to publish", report: true }
      channel: { values: [blog, changelog] }
      due: { type: date, optional: true }
  refund-args:
    properties:
      amount: { type: integer, min: 1, unit: usd_cents, report: true }
      currency: { values: [usd, eur], report: true }
  refund-result:
    properties:
      status: { values: [succeeded, pending], report: true }
      id: { type: string, max: 64 }
`;

const CONNECTIONS = `connections:
  pay:
    command: ${JSON.stringify(process.execPath)}
    args: [./providers/pay.cjs]
    env:
      PAY_MODE: test
    operations:
      refund: { input: refund-args, output: refund-result }
      list: {}
`;

const AGENTS = RESOURCES["resources/agents.yaml"].replace(
  `${api}\nkind: Agent\nmetadata: { name: publisher }`,
  `${api}\nkind: Agent\nmetadata: { name: publisher }\nspec: { brief: publish-brief }`,
);

const FILES = {
  ...RESOURCES,
  "resources/agents.yaml": AGENTS,
  "providers/pay.cjs": PROVIDER,
  "nodrail.yaml": `${RESOURCES["nodrail.yaml"].replace(
    "runtime: claude-code",
    "runtimes: [claude-code, codex, copilot]",
  )}${SHAPES}${CONNECTIONS}`,
};

describe("connection input and output shapes", () => {
  test("lock, with the setup schema still strict about everything else", async () => {
    const p = await locked(FILES);
    const lock = parse(p.read("nodrail.lock.yaml"));
    expect(lock.contractsBaseline.bindings["input:pay.refund"]).toMatchObject({
      surface: "S03",
      shape: "refund-args",
    });
    expect(lock.contractsBaseline.bindings["output:pay.refund"]).toMatchObject({
      surface: "S04",
      shape: "refund-result",
    });
    expect(Object.keys(lock.contracts.shapes)).toContain("refund-result");
    // The lock records nodrail.yaml as written, slots included.
    expect((await p.run("policy", "export", "--frozen")).code).toBe(0);
    const unknown = project({
      ...FILES,
      "nodrail.yaml": FILES["nodrail.yaml"].replace(
        "list: {}",
        "list: { colour: red }",
      ),
    });
    expect((await unknown.run("policy", "lock")).code).toBe(1);
    const missing = project({
      ...FILES,
      "nodrail.yaml": FILES["nodrail.yaml"].replace(
        "output: refund-result",
        "output: refund-reslt",
      ),
    });
    const err = (await missing.run("policy", "lock")).err;
    expect(err).toContain(
      "nodrail.yaml connections.pay.operations.refund.output",
    );
  });

  test("connections.json carries each mediated connection's contracts; without them it is as before", async () => {
    const p = await locked(FILES);
    const file = JSON.parse(
      fileOf(planFor(p, "claude-code"), CONNECTIONS_FILE),
    );
    expect(Object.keys(file)).toEqual(["connections", "contracts"]);
    expect(file.connections.pay.operations).toEqual({ refund: {}, list: {} });
    expect(file.contracts.pay.bindings).toEqual([
      { name: "input:pay.refund", surface: "S03", shape: "refund-args" },
      { name: "output:pay.refund", surface: "S04", shape: "refund-result" },
    ]);
    const lock = parse(p.read("nodrail.lock.yaml"));
    expect(file.contracts.pay.shapes["refund-args"].contract).toBe(
      lock.contracts.shapes["refund-args"].contract,
    );
    const plain = await locked({
      ...FILES,
      "nodrail.yaml": FILES["nodrail.yaml"].replace(
        "{ input: refund-args, output: refund-result }",
        "{}",
      ),
    });
    expect(
      Object.keys(
        JSON.parse(fileOf(planFor(plain, "claude-code"), CONNECTIONS_FILE)),
      ),
    ).toEqual(["connections"]);
  });

  test("validate and explain take input: and output: bindings", async () => {
    const p = await locked(FILES);
    p.write(
      "samples/args.json",
      '{ "amount": 0, "currency": "gbp", "note": "secret-note" }',
    );
    const bad = await p.run(
      "contracts",
      "validate",
      "input:pay.refund",
      "samples/args.json",
    );
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("amount: below");
    expect(bad.out).toContain("currency: enum");
    expect(bad.out).toContain("note: unknown");
    expect(bad.out).not.toContain("secret-note");
    p.write("samples/result.json", '{ "status": "succeeded", "id": "re_1" }');
    const good = await p.run(
      "contracts",
      "validate",
      "output:pay.refund",
      "samples/result.json",
    );
    expect(good.out).toContain(
      'Reported (may leave this machine): {"status":"succeeded"}',
    );
    const input = (await p.run("contracts", "explain", "input:pay.refund")).out;
    expect(input).toContain(
      "input:pay.refund (S03, enforced by the hook and the connection Nodrail runs)",
    );
    expect(input).toContain("before the provider is called");
    const output = (await p.run("contracts", "explain", "output:pay.refund"))
      .out;
    expect(output).toContain("An invalid or unreadable result is withheld");
  });
});

describe("briefs", () => {
  test("the agent that starts one gets a marked section; the agent started and the sources don't", async () => {
    const p = await locked(FILES);
    const { claude, copilot } = leadFiles(p);
    const codex = fileOf(planFor(p, "codex"), ".codex/config.toml");
    for (const text of [claude, copilot, codex]) {
      expect(text.split(BRIEF_BEGIN)).toHaveLength(2);
      expect(text).toContain("## Briefs for the agents you start");
    }
    expect(claude.split(BRIEF_END)).toHaveLength(2);
    expect(claude).toContain(
      "You lead the release.\n\n<!-- nodrail:brief begin: briefs for publisher.",
    );
    expect(claude).toContain("End the prompt with a `nodrail-brief` block");
    expect(claude).toContain("Brief publish-brief, contract sha256:");
    expect(claude).toContain("What the publisher needs to start");
    expect(claude).toContain(
      "- `channel` (required): one of `blog`, `changelog`.",
    );
    expect(claude).toContain('due: "2026-01-01"');
    expect(
      fileOf(planFor(p, "claude-code"), ".claude/agents/publisher.md"),
    ).not.toContain(BRIEF_BEGIN);
    expect(p.read("resources/lead.md")).toBe("You lead the release.\n");
    // The example, as a dispatch prompt, reads back as a valid brief.
    const example = /```nodrail-brief\n[\s\S]*?\n```/.exec(claude)![0];
    p.write("samples/dispatch.md", `Publish the notes.\n\n${example}\n`);
    const read = await p.run(
      "contracts",
      "validate",
      "brief:publisher",
      "samples/dispatch.md",
    );
    expect(read.code).toBe(0);
    expect(read.out).toContain(
      'Reported (may leave this machine): {"issue":"example"}',
    );
  });

  test("render prints an agent's sections, or one brief's for an agent nodrail doesn't set up", async () => {
    const p = await locked(FILES);
    const lead = await p.run("contracts", "render", "lead");
    expect(lead.code).toBe(0);
    expect(
      fileOf(planFor(p, "claude-code"), ".claude/agents/lead.md"),
    ).toContain(lead.out);
    const one = await p.run("contracts", "render", "brief:publisher");
    expect(one.out).toContain("### publisher");
    expect((await p.run("contracts", "render", "brief:lead")).err).toContain(
      "lead has no declared brief",
    );
    expect((await p.run("contracts", "render", "loner")).err).toContain(
      "loner has no declared receipt and starts no agent with a brief",
    );
  });

  test("validate reads a dispatch prompt's final brief block, and keeps missing, invalid and valid apart", async () => {
    const p = await locked(FILES);
    const check = async (text: string) => {
      p.write("samples/brief.md", text);
      return p.run(
        "contracts",
        "validate",
        "brief:publisher",
        "samples/brief.md",
      );
    };
    const valid = await check(
      "Go.\n\n```nodrail-brief\nagent: publisher\nissue: ENG-1\nchannel: blog\n```\n",
    );
    expect(valid.code).toBe(0);
    const other = await check(
      "```nodrail-brief\nagent: lead\nissue: ENG-1\nchannel: blog\n```\n",
    );
    expect(other.out).toContain("agent: identity (expected publisher)");
    const word = await check(
      "```nodrail-brief\nissue: ENG-1\nchannel: podcast-x\n```\n",
    );
    expect(word.out).toContain("channel: enum");
    expect(word.out).not.toContain("podcast-x");
    const after = await check(
      "```nodrail-brief\nissue: ENG-1\nchannel: blog\n```\nThanks!\n",
    );
    expect(after.out).toContain(
      "missing: samples/brief.md against brief:publisher",
    );
    expect(after.out).toContain(
      "no nodrail-brief block ends the prompt: it counts as no brief.",
    );
    const twice = await check(
      "```nodrail-brief\nissue: a\nissue: b\nchannel: blog\n```\n",
    );
    expect(twice.out).toContain("(value): parse");
    p.write("samples/value.yaml", "issue: ENG-1\nchannel: changelog\n");
    expect(
      (
        await p.run(
          "contracts",
          "validate",
          "brief:publisher",
          "samples/value.yaml",
        )
      ).code,
    ).toBe(0);
  });

  test("a brief block over 16 KiB is invalid, not missing", async () => {
    const p = await locked(FILES);
    const contracts = (await import("../src/commands/project.ts")).frozenPolicy(
      { root: p.cwd, home: p.home },
    ).contracts;
    const reading = readBrief(
      `\`\`\`nodrail-brief\nissue: ${"x".repeat(17 * 1024)}\n\`\`\`\n`,
      briefOf(contracts, "publisher")!.contract,
      "publisher",
    );
    expect(reading).toMatchObject({
      state: "invalid",
      issues: [{ code: "size" }],
    });
  });

  test("explain names who starts the agent", async () => {
    const p = await locked(FILES);
    const out = (await p.run("contracts", "explain", "brief:publisher")).out;
    expect(out).toContain("brief:publisher (S02, enforced by the hook)");
    expect(out).toContain("Started by: lead, whose agent files describe it");
    expect(out).toContain("read by the hook before the agent starts");
    const plan = planFor(p, "claude-code").notes.join("\n");
    expect(plan).toContain(
      "Each brief is described in the files of the agents that start it",
    );
    expect(plan).toContain("  input:pay.refund: shape refund-args");
  });
});

/** Compiled contracts from a nodrail.yaml fragment and Agent specs. */
function compiled(manifest: string, publisher = "{ brief: b }") {
  const result = compileContracts({
    manifest: parse(manifest),
    resources: [
      parse(
        `${api}\nkind: Agent\nmetadata: { name: publisher }\nspec: ${publisher}`,
      ),
    ],
  });
  expect(result.issues).toEqual([]);
  return result.contracts!;
}

describe("classifying brief and connection changes", () => {
  const base = `shapes:
  b: { properties: { issue: { type: string, max: 40 }, risk: { values: [low, high] } } }
  args: { properties: { amount: { type: integer, min: 1 } } }
  result: { properties: { status: { values: [ok, pending] } } }
connections:
  pay: { command: x, operations: { refund: { input: args, output: result } } }
`;
  const before = lockedContracts(compiled(base)).contractsBaseline;
  const changesTo = (manifest: string, publisher?: string) =>
    contractChanges(before, compiled(manifest, publisher)).map(
      (c) => `${c.kind} ${c.subject} ${c.what}`,
    );

  test("narrowing a brief or a connection slot is breaking; reporting is disclosure", () => {
    expect(
      changesTo(
        base
          .replace("max: 40 }", "max: 20, report: true }")
          .replace("min: 1 }", "min: 100 }")
          .replace("values: [ok, pending]", "values: [ok]"),
      ),
    ).toEqual([
      "breaking brief:publisher issue: bounds narrowed",
      "breaking input:pay.refund amount: bounds narrowed",
      "breaking output:pay.refund status: no longer accepts pending",
      "disclosure brief:publisher issue: now reported, so it leaves this machine",
    ]);
  });

  test("a new connection slot is breaking, a removed one needs review, a changed brief is breaking", () => {
    expect(
      changesTo(
        base.replace("{ input: args, output: result }", "{ input: args }"),
      ),
    ).toEqual([
      "unknown output:pay.refund removed: its results reach the agent unchecked; review it as a policy change",
    ]);
    const none = lockedContracts(
      compiled(base.replace("{ input: args, output: result }", "{}")),
    ).contractsBaseline;
    expect(
      contractChanges(none, compiled(base)).map(
        (c) => `${c.kind} ${c.subject} ${c.what}`,
      ),
    ).toEqual([
      "breaking input:pay.refund new, with shape args: calls whose arguments don't match are refused before the provider",
      "breaking output:pay.refund new, with shape result: results that don't match are withheld from the agent",
    ]);
    expect(changesTo(base, "{}")).toEqual([
      "breaking brief:publisher removed; whatever reads it no longer can",
      "breaking agent publisher now takes no declared brief (was b)",
    ]);
  });
});

describe.skipIf(windows)("a mediated connection", () => {
  /** Speaks MCP to `connection run` over in-memory streams. */
  async function session(p: ReturnType<typeof project>) {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const answers = new Map<number, (value: any) => void>();
    let buffer = "";
    stdout.on("data", (data: Buffer) => {
      buffer += data.toString();
      let at;
      while ((at = buffer.indexOf("\n")) >= 0) {
        const message = JSON.parse(buffer.slice(0, at));
        buffer = buffer.slice(at + 1);
        answers.get(message.id)?.(message);
      }
    });
    let id = 0;
    const ask = (method: string, params: object = {}) =>
      new Promise<any>((done) => {
        id += 1;
        answers.set(id, done);
        stdin.write(
          `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
        );
      });
    const env = { ...p.env, NOT_FOR_PROVIDER: "x" };
    const served = runMediated(join(p.cwd, CONNECTIONS_FILE), "pay", env, {
      stdin,
      stdout,
    });
    await ask("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
    });
    return { ask, close: () => stdin.end(), served };
  }

  test("refuses bad arguments before the provider, withholds a bad result, and records each call", async () => {
    const p = await locked({
      ...FILES,
      "nodrail.yaml": FILES["nodrail.yaml"].replace(
        "runtimes: [claude-code, codex, copilot]",
        "runtime: claude-code",
      ),
    });
    expect((await p.run("apply", "--yes")).code).toBe(0);
    const { ask, close, served } = await session(p);
    const call = (args: object) =>
      ask("tools/call", { name: "refund", arguments: args });
    const refused = await call({ amount: 0, currency: "usd" });
    expect(refused.result.isError).toBe(true);
    expect(refused.result.content[0].text).toContain(
      "Nothing was sent to the provider",
    );
    expect(existsSync(join(p.cwd, "provider-calls.jsonl"))).toBe(false);
    const ok = await call({ amount: 500, currency: "usd" });
    expect(JSON.parse(ok.result.content[0].text)).toEqual({
      status: "succeeded",
      id: "re_1",
    });
    const strange = await call({ amount: 5000, currency: "eur" });
    expect(strange.result.isError).toBe(true);
    expect(strange.result.content[0].text).toContain("withholds the result");
    expect(strange.result.content[0].text).not.toContain("strange");
    close();
    expect(await served).toBe(true);
    // The provider was called twice, with only its declared environment.
    const calls = readFileSync(join(p.cwd, "provider-calls.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls).toHaveLength(2);
    expect(calls[0].env).toContain("PAY_MODE");
    expect(calls[0].env).not.toContain("NOT_FOR_PROVIDER");
    const records = readFileSync(
      join(p.cwd, ".nodrail/records/pay/calls.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      records.map((r) => [
        r.execution,
        r.input?.state,
        r.result?.state ?? null,
        r.delivered,
      ]),
    ).toEqual([
      ["not-called", "invalid", null, false],
      ["succeeded", "valid", "valid", true],
      ["succeeded", "valid", "invalid", false],
    ]);
    expect(records[1].input.values).toEqual({ amount: 500, currency: "usd" });
    // Records are the project's data: destroy keeps them.
    expect((await p.run("destroy", "--yes")).code).toBe(0);
    expect(existsSync(join(p.cwd, ".nodrail/records/pay/calls.jsonl"))).toBe(
      true,
    );
  });

  test("a connection without declared shapes isn't mediated", async () => {
    const p = await locked({
      ...FILES,
      "nodrail.yaml": FILES["nodrail.yaml"]
        .replace(
          "runtimes: [claude-code, codex, copilot]",
          "runtime: claude-code",
        )
        .replace("{ input: refund-args, output: refund-result }", "{}"),
    });
    expect((await p.run("apply", "--yes")).code).toBe(0);
    const streams = { stdin: new PassThrough(), stdout: new PassThrough() };
    expect(
      await runMediated(join(p.cwd, CONNECTIONS_FILE), "pay", p.env, streams),
    ).toBe(false);
  });
});
