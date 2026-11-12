// Runs and steps through the SDK, for agents that aren't Claude Code: the run
// and step reach the server with every call made inside a step, even through
// a real agent framework's tool loop.
import { tool as agentsTool } from "@openai/agents";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { createNodrail } from "../src/index";
import { receiptOf } from "../src/runs";
import { runOpenAiAgents } from "./support/agents";
import { fakeNodrail } from "./support/fake-nodrail";

const connect = (
  options: { run?: string; env?: Record<string, string> } = {},
) => {
  const server = fakeNodrail();
  const nodrail = createNodrail({
    url: "https://nodrail.test",
    credential: "c",
    waitMs: 0,
    fetch: server.fetch,
    env: options.env ?? {},
    ...(options.run ? { run: options.run } : {}),
  });
  return { server, nodrail };
};

const sent = (server: ReturnType<typeof fakeNodrail>, path: string) =>
  server.requests
    .filter((request) => request.path === path)
    .map((request) => request.body);

const action = {
  tool: "github",
  operation: "pulls.create",
  resource: "acme/app",
};

describe("runs in the SDK", () => {
  test("a call outside any run carries no run", async () => {
    const { server, nodrail } = connect();
    await nodrail.check(action);
    expect(sent(server, "/actions")[0]).not.toHaveProperty("run");
  });

  test("the run comes from the options, then NODRAIL_RUN", async () => {
    const fromOptions = connect({ run: "ENG-1" });
    await fromOptions.nodrail.check(action);
    expect(sent(fromOptions.server, "/actions")[0]?.run).toEqual({
      key: "ENG-1",
    });

    const fromEnv = connect({ env: { NODRAIL_RUN: "ENG-2" } });
    await fromEnv.nodrail.check(action);
    expect(sent(fromEnv.server, "/actions")[0]?.run).toEqual({ key: "ENG-2" });
  });

  test("a step is recorded around its work, and its calls belong to it", async () => {
    const { server, nodrail } = connect();
    const result = await nodrail.inRun("ENG-3", () =>
      nodrail.step("QA", async () => {
        await nodrail.check(action);
        return "All checks ran.\n\n```nodrail-receipt\nverdict: pass\n```\n";
      }),
    );
    expect(result).toContain("All checks ran.");
    const [started, finished] = sent(server, "/steps");
    const step = (started as { step: { id: string; agent: string } }).step;
    expect(started).toEqual({ run: { key: "ENG-3" }, step, event: "started" });
    expect(step.agent).toBe("qa");
    expect(finished).toEqual({
      run: { key: "ENG-3" },
      step,
      event: "finished",
      receipt: { text: "```nodrail-receipt\nverdict: pass\n```\n" },
    });
    expect(sent(server, "/actions")[0]?.run).toEqual({ key: "ENG-3", step });
  });

  test("steps running side by side keep their own calls", async () => {
    const { server, nodrail } = connect({ run: "ENG-4" });
    const pause = () => new Promise((done) => setTimeout(done, 5));
    await Promise.all(
      ["dev", "docs"].map((agent) =>
        nodrail.step(agent, async () => {
          await pause();
          await nodrail.check({ ...action, operation: `${agent}.write` });
        }),
      ),
    );
    for (const body of sent(server, "/actions")) {
      const { run, operation } = body as {
        run: { step: { agent: string } };
        operation: string;
      };
      expect(operation).toBe(`${run.step.agent}.write`);
    }
  });

  test("a step that throws finishes with no verdict and the error goes on", async () => {
    const { server, nodrail } = connect({ run: "ENG-5" });
    await expect(
      nodrail.step("dev", () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(sent(server, "/steps").map((body) => body.event)).toEqual([
      "started",
      "finished",
    ]);
    expect(sent(server, "/steps")[1]).not.toHaveProperty("receipt");
  });

  test("a step needs a run", async () => {
    const { nodrail } = connect();
    await expect(nodrail.step("qa", () => "x")).rejects.toThrow(/needs a run/);
  });

  test("a result can be read with a function of your own", async () => {
    const { server, nodrail } = connect({ run: "ENG-6" });
    await nodrail.step("qa", () => ({ ok: true }), {
      receipt: (result) => ({
        verdict: result.ok ? "pass" : "fail",
        findings: [],
        usage: {},
      }),
    });
    expect(sent(server, "/steps")[1]?.receipt).toEqual({
      verdict: "pass",
      findings: [],
      usage: {},
    });
  });

  test("a step survives a real framework's tool loop", async () => {
    const { server, nodrail } = connect({ run: "ENG-7" });
    const tools = nodrail.guard([
      agentsTool({
        name: "create_issue",
        description: "x",
        parameters: z.object({ title: z.string() }),
        execute: () => "done",
      }),
    ]);
    await nodrail.step("dev", () =>
      runOpenAiAgents(tools, "create_issue", { title: "Hi" }),
    );
    const [call] = sent(server, "/actions");
    expect(call?.run).toMatchObject({ key: "ENG-7", step: { agent: "dev" } });
  });
});

describe("reading a receipt from a result", () => {
  test.each([
    ["a string with no receipt", "done", null],
    [
      "a receipt quoted mid-message",
      "```nodrail-receipt\nverdict: pass\n```\nThen it failed.",
      null,
    ],
    [
      "an object with a verdict",
      {
        verdict: "ship",
        findings: ["naming", 3],
        usage: { usd: 0.2, tokens: -1 },
      },
      { verdict: "ship", findings: ["naming"], usage: { usd: 0.2 } },
    ],
    ["an object without one", { ok: true }, null],
  ])("%s", (_, result, expected) => {
    expect(receiptOf(result)).toEqual(expected);
  });
});
