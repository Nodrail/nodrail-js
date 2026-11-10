import { tool as agentsTool } from "@openai/agents";
import { tool as aiTool } from "ai";
import { tool as langchainTool } from "langchain";
import { describe, expect, expectTypeOf, test, vi } from "vitest";
import { z } from "zod";
import { createNodrail, NodrailBlockedError } from "../src/index";
import { describerFor } from "../src/sdk";
import { nodrailMiddleware } from "../src/langchain";
import { runAiSdk, runLangChain, runOpenAiAgents } from "./support/agents";
import { fakeNodrail } from "./support/fake-nodrail";

const connected = (answer?: Parameters<typeof fakeNodrail>[0]) => {
  const server = fakeNodrail(answer);
  const nodrail = createNodrail({
    url: "https://nodrail.test",
    credential: "c",
    waitMs: 0,
    fetch: server.fetch,
    env: {},
  });
  return { server, nodrail };
};

const denyAll = () => "DENIED";
const input = { title: "Hello" };
const schema = z.object({ title: z.string() });

describe.each([
  {
    framework: "LangChain createAgent",
    build: (work: () => string) => [
      langchainTool(work, { name: "create_issue", description: "x", schema }),
    ],
    drive: (tools: unknown[]) => runLangChain(tools, "create_issue", input),
  },
  {
    framework: "Vercel AI SDK generateText",
    build: (work: () => string) => ({
      create_issue: aiTool({ inputSchema: schema, execute: work }),
    }),
    drive: (tools: unknown) => runAiSdk(tools as never, "create_issue", input),
  },
  {
    framework: "OpenAI Agents run",
    build: (work: () => string) => [
      agentsTool({
        name: "create_issue",
        description: "x",
        parameters: schema,
        execute: work,
      }),
    ],
    drive: (tools: unknown[]) => runOpenAiAgents(tools, "create_issue", input),
  },
] as const)("$framework", ({ build, drive }) => {
  test("an allowed tool runs, and what it did is reported", async () => {
    const { server, nodrail } = connected();
    const work = vi.fn(() => "created");
    const output = await drive(nodrail.guard(build(work)) as never);
    expect(work).toHaveBeenCalledOnce();
    expect(JSON.stringify(output)).toContain("created");
    expect(server.seen()[0]).toMatchObject({
      tool: "create_issue",
      operation: "call",
      resource: { kind: "tool", id: "create_issue" },
      params: { input },
    });
    expect(server.reports[0]?.outcome).toBe("success");
  });

  test("a denied tool never runs and the agent reads why", async () => {
    const { nodrail } = connected(denyAll);
    const work = vi.fn(() => "created");
    const output = await drive(nodrail.guard(build(work)) as never);
    expect(work).not.toHaveBeenCalled();
    expect(JSON.stringify(output)).toContain("this action is denied");
  });
});

const middlewareOn = (server: ReturnType<typeof fakeNodrail>) =>
  nodrailMiddleware({
    url: "https://nodrail.test",
    credential: "c",
    waitMs: 0,
    fetch: server.fetch,
    env: {},
  });

describe("LangChain", () => {
  const build = (work: () => string) =>
    langchainTool(work, { name: "create_issue", description: "x", schema });

  async function throughMiddleware(server: ReturnType<typeof fakeNodrail>) {
    const work = vi.fn(() => "created");
    const output = await runLangChain([build(work)], "create_issue", input, [
      middlewareOn(server),
    ]);
    return { work, output };
  }

  test("the middleware covers tools without touching them", async () => {
    const { server } = connected();
    const { work, output } = await throughMiddleware(server);
    expect(work).toHaveBeenCalledOnce();
    expect(output).toBe("created");
    expect(server.seen()).toHaveLength(1);
  });

  test("the middleware blocks with a reason the agent can read", async () => {
    const { work, output } = await throughMiddleware(fakeNodrail(denyAll));
    expect(work).not.toHaveBeenCalled();
    expect(output).toContain("this action is denied");
  });

  test("using both does not ask twice", async () => {
    const { server, nodrail } = connected();
    const middleware = middlewareOn(server);
    await runLangChain(
      nodrail.guard([build(() => "created")]),
      "create_issue",
      input,
      [middleware],
    );
    expect(server.seen()).toHaveLength(1);
  });

  test("a guarded tool is still a tool when called directly", async () => {
    const { nodrail, server } = connected();
    const guarded = nodrail.guard(build(() => "created"));
    await expect(guarded.invoke(input)).resolves.toBe("created");
    expect(guarded.name).toBe("create_issue");
    expect(guarded).toBeInstanceOf(Object.getPrototypeOf(guarded).constructor);
    expect(server.seen()).toHaveLength(1);
  });

  test("a tool returning an artifact stays valid when blocked", async () => {
    const { nodrail } = connected(denyAll);
    const artifactTool = langchainTool(() => ["created", { id: 1 }], {
      name: "create_issue",
      description: "x",
      schema,
      responseFormat: "content_and_artifact",
    });
    await expect(
      runLangChain(nodrail.guard([artifactTool]), "create_issue", input),
    ).resolves.toContain("this action is denied");
  });
});

describe("Vercel AI SDK", () => {
  test("a streaming tool yields nothing unless allowed", async () => {
    const { nodrail } = connected(denyAll);
    const started = vi.fn();
    const tools = nodrail.guard({
      stream_it: aiTool({
        inputSchema: schema,
        async *execute() {
          started();
          yield "partial";
        },
      }),
    });
    const output = await runAiSdk(tools, "stream_it", input);
    expect(started).not.toHaveBeenCalled();
    expect(output).toContain("this action is denied");
  });

  test("an allowed streaming tool still streams", async () => {
    const { nodrail, server } = connected();
    const tools = nodrail.guard({
      stream_it: aiTool({
        inputSchema: schema,
        async *execute() {
          yield "partial";
          yield "final";
        },
      }),
    });
    await expect(runAiSdk(tools, "stream_it", input)).resolves.toBe("final");
    expect(server.reports[0]?.outcome).toBe("success");
  });

  test("tools that run elsewhere pass through", () => {
    const { nodrail } = connected();
    const clientSide = aiTool({ inputSchema: schema });
    expect(nodrail.guard({ clientSide }).clientSide).toBe(clientSide);
  });
});

describe("tool shapes from other libraries", () => {
  const work = () => vi.fn((_input?: unknown, _extra?: unknown) => "ran");

  test.each([
    [
      "Mastra",
      (fn: ReturnType<typeof work>) => ({ id: "send", execute: fn }),
      (t: never) => (t as { execute: (i: object) => unknown }).execute(input),
    ],
    [
      "Anthropic tool runner",
      (fn: ReturnType<typeof work>) => ({ name: "send", run: fn }),
      (t: never) => (t as { run: (i: object) => unknown }).run(input),
    ],
    [
      "OpenAI runTools",
      (fn: ReturnType<typeof work>) => ({
        type: "function",
        function: { name: "send", function: fn },
      }),
      (t: never) =>
        (
          t as { function: { function: (i: string) => unknown } }
        ).function.function(JSON.stringify(input)),
    ],
    [
      "LlamaIndex",
      (fn: ReturnType<typeof work>) => ({
        metadata: { name: "send" },
        call: fn,
      }),
      (t: never) => (t as { call: (i: object) => unknown }).call(input),
    ],
  ])("%s runs only when allowed", async (_name, build, call) => {
    const allowed = connected();
    const ran = work();
    await expect(
      call(allowed.nodrail.guard(build(ran)) as never),
    ).resolves.toBe("ran");
    expect(ran).toHaveBeenCalledOnce();
    expect(allowed.server.seen()[0]?.params).toMatchObject({ input });

    const denied = connected(denyAll);
    const blocked = work();
    await expect(
      call(denied.nodrail.guard(build(blocked)) as never),
    ).resolves.toContain("denied");
    expect(blocked).not.toHaveBeenCalled();
  });

  test("Claude Agent SDK handlers answer with an error block", async () => {
    const { nodrail } = connected(denyAll);
    const handler = work();
    const guarded = nodrail.guard({ name: "send", handler });
    await expect(guarded.handler(input)).resolves.toMatchObject({
      isError: true,
      content: [{ type: "text" }],
    });
    expect(handler).not.toHaveBeenCalled();
  });

  test("a class instance keeps its methods and its identity", async () => {
    class MyTool {
      id = "send";
      prefix = "ran";
      execute() {
        return this.prefix;
      }
    }
    const { nodrail } = connected();
    const guarded = nodrail.guard(new MyTool());
    expect(guarded).toBeInstanceOf(MyTool);
    await expect(guarded.execute()).resolves.toBe("ran");
  });
});

describe("guard", () => {
  test("wraps a plain function by its name", async () => {
    const { nodrail, server } = connected();
    async function sendEmail(args: { to: string }) {
      return `sent to ${args.to}`;
    }
    await expect(nodrail.guard(sendEmail)({ to: "a" })).resolves.toBe(
      "sent to a",
    );
    expect(server.seen()[0]?.resource).toEqual({
      kind: "tool",
      id: "sendEmail",
    });
  });

  test("refuses a function it cannot name", () => {
    const { nodrail } = connected();
    expect(() => nodrail.guard(() => 1)).toThrow(/no name/);
    expect(nodrail.guard(() => 1, { name: "x" })).toBeTypeOf("function");
  });

  test("refuses anything it would leave unguarded", () => {
    const { nodrail } = connected();
    expect(() => nodrail.guard({ tool: { doIt: 1 } })).toThrow(/don't know/);
    expect(() => nodrail.guard("nope")).toThrow(/not a tool/);
  });

  test("rules can match what a tool acts on", async () => {
    const { nodrail, server } = connected();
    const tools = nodrail.guard(
      { issue: aiTool({ inputSchema: schema, execute: () => "ok" }) },
      {
        describe: {
          issue: (args) => ({
            tool: "github",
            operation: "issues.create",
            resource: {
              kind: "repository",
              id: (args as { title: string }).title,
            },
          }),
        },
      },
    );
    await tools.issue.execute?.(input, {} as never);
    expect(server.seen()[0]).toMatchObject({
      tool: "github",
      operation: "issues.create",
      resource: { kind: "repository", id: "Hello" },
    });
  });

  test("a credential loaded after the tools were wrapped is picked up", async () => {
    const server = fakeNodrail();
    const env: Record<string, string | undefined> = {};
    const nodrail = createNodrail({ url: "https://nodrail.test", waitMs: 0, fetch: server.fetch, env });
    const work = vi.fn((_input: object) => "ran");
    const send = nodrail.guard(work, { name: "send" });
    await expect(send({})).resolves.toContain("not configured");
    env.NODRAIL_CREDENTIAL = "c";
    await expect(send({})).resolves.toBe("ran");
    expect(work).toHaveBeenCalledTimes(1);
  });

  test("secrets in arguments never leave the process", async () => {
    const { nodrail, server } = connected();
    const send = nodrail.guard((_args: object) => "ok", { name: "send" });
    await send({ api_key: "sk-supersecretvalue", body: "fine" });
    expect(JSON.stringify(server.seen())).not.toContain("supersecret");
  });

  test("what cannot be described cannot run", async () => {
    const { nodrail, server } = connected();
    const work = vi.fn();
    const send = nodrail.guard(work, { name: "send" });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(send(circular)).resolves.toContain("INVALID_ACTION");
    expect(work).not.toHaveBeenCalled();
    expect(server.seen()).toHaveLength(0);
  });

  test("a failed tool is reported and its error is kept", async () => {
    const { nodrail, server } = connected();
    const send = nodrail.guard(
      () => {
        throw new Error("boom");
      },
      { name: "send" },
    );
    await expect(send()).rejects.toThrow("boom");
    expect(server.reports[0]?.outcome).toBe("failure");
  });

  test("a lost report does not disturb the tool", async () => {
    const { server } = connected();
    const send = (async (url: string, init: RequestInit) => {
      if (String(url).endsWith("/reports")) throw new Error("offline");
      return server.fetch(url, init);
    }) as unknown as typeof fetch;
    const nodrail = createNodrail({
      credential: "c",
      waitMs: 0,
      fetch: send,
      env: {},
    });
    await expect(nodrail.guard(() => "ok", { name: "s" })()).resolves.toBe(
      "ok",
    );
  });

  test("onBlocked can throw or answer in the tool's own format", async () => {
    const { nodrail } = connected(denyAll);
    const thrown = nodrail.guard(() => "x", {
      name: "s",
      onBlocked: "throw",
    });
    await expect(thrown()).rejects.toBeInstanceOf(NodrailBlockedError);
    await expect(thrown()).rejects.toMatchObject({
      code: "DENIED",
      reference: "APR-TEST0001",
    });
    const custom = nodrail.guard(() => "x", {
      name: "s",
      onBlocked: (error) => ({ refused: error.code }),
    });
    await expect(custom()).resolves.toEqual({ refused: "DENIED" });
  });
});

describe("configuration", () => {
  test("with no credential nothing runs, and the reason says what to do", async () => {
    const nodrail = createNodrail({
      env: { NODRAIL_HOME: "/nonexistent" },
      fetch: fakeNodrail().fetch,
    });
    const work = vi.fn();
    await expect(nodrail.guard(work, { name: "s" })()).resolves.toContain(
      "NODRAIL_CREDENTIAL",
    );
    expect(work).not.toHaveBeenCalled();
  });

  test("the service being unreachable blocks", async () => {
    const nodrail = createNodrail({
      credential: "c",
      waitMs: 0,
      env: {},
      fetch: (() =>
        Promise.reject(new Error("down"))) as unknown as typeof fetch,
    });
    const work = vi.fn();
    await expect(nodrail.guard(work, { name: "s" })()).resolves.toContain(
      "UNAVAILABLE",
    );
    expect(work).not.toHaveBeenCalled();
  });

  test("run() throws when blocked and returns when allowed", async () => {
    const action = { tool: "github", operation: "issues.create" };
    const allowed = connected();
    await expect(allowed.nodrail.run(action, () => 42)).resolves.toBe(42);
    expect(allowed.server.seen()[0]?.resource).toEqual({
      kind: "tool",
      id: "github.issues.create",
    });
    await expect(
      connected(denyAll).nodrail.run(action, () => 42),
    ).rejects.toBeInstanceOf(NodrailBlockedError);
  });

  test("check() takes a resource as plain text", async () => {
    const { nodrail, server } = connected();
    await nodrail.check({
      tool: "github",
      operation: "issues.create",
      resource: "acme/app",
      params: { title: "x" },
    });
    expect(server.seen()[0]?.resource).toEqual({
      kind: "resource",
      id: "acme/app",
    });
  });
});

describe("what guard's type promises", () => {
  const { nodrail } = connected();

  test("a plain function has to ask first, so it returns a promise", () => {
    const send = nodrail.guard((_args: { to: string }): number => 1, { name: "send" });
    expectTypeOf(send).toEqualTypeOf<(_args: { to: string }) => Promise<number>>();
    expectTypeOf(nodrail.guard({ send: async () => "sent" })).toEqualTypeOf<{
      send: () => Promise<string>;
    }>();
  });

  test("a framework's tools keep their own type, so they still fit the agent", () => {
    const aiTools = {
      create_issue: aiTool({ inputSchema: schema, execute: () => "done" }),
    };
    expectTypeOf(nodrail.guard(aiTools)).toEqualTypeOf<typeof aiTools>();
    const langchainTools = [
      langchainTool(() => "done", { name: "x", description: "x", schema }),
    ];
    expectTypeOf(nodrail.guard(langchainTools)).toEqualTypeOf<
      typeof langchainTools
    >();
    const agentsTools = [
      agentsTool({ name: "x", description: "x", parameters: schema, execute: () => "done" }),
    ];
    expectTypeOf(nodrail.guard(agentsTools)).toEqualTypeOf<typeof agentsTools>();
  });
});

// Each of these ran unchecked in 0.1.0: guard returned the tool untouched.
describe("nothing with code of its own slips through", () => {
  const unconfigured = () =>
    createNodrail({ env: { NODRAIL_HOME: "/nonexistent" }, waitMs: 0 });
  const ran = vi.fn(() => "RAN");

  test.each([
    ["a provider tool that still runs locally", { type: "provider", id: "anthropic.bash", inputSchema: {}, execute: ran }, "execute"],
    ["an MCP SDK registered tool", { inputSchema: {}, callback: ran }, "callback"],
    ["a tool that runs through run()", { inputSchema: {}, run: ran }, "run"],
  ])("%s is checked", async (_label, tool, method) => {
    ran.mockClear();
    const guardedTool = unconfigured().guard({ shell: tool }).shell as Record<string, unknown>;
    expect(guardedTool).not.toBe(tool);
    const result = await (guardedTool[method] as (input: object) => unknown).call(guardedTool, { command: "rm -rf ~" });
    expect(ran).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).toContain("not configured");
  });

  test("a tool can't mark itself as already checked", async () => {
    ran.mockClear();
    const forged = { [Symbol.for("nodrail.guarded")]: true, name: "shell", execute: ran };
    const guardedTool = unconfigured().guard(forged);
    // A tool object keeps its own type; the guarded call returns a promise.
    await (guardedTool.execute as unknown as () => Promise<unknown>)();
    expect(ran).not.toHaveBeenCalled();
  });

  test("code in a shape it doesn't know is refused, not left unguarded", () => {
    expect(() =>
      unconfigured().guard({ shell: { inputSchema: {}, call: ran } }),
    ).toThrow(/doesn't recognise/);
  });

  test("a tool with no code here, such as hosted search, passes through", () => {
    const hosted = { type: "provider", id: "openai.web_search", args: {} };
    expect(unconfigured().guard({ search: hosted }).search).toBe(hosted);
  });
});

test("a tool named like an Object property gets no description from Object", () => {
  const describe = { create_issue: () => ({ tool: "github", operation: "issues.create" }) };
  for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty"])
    expect(describerFor(describe, name)).toBeUndefined();
  expect(describerFor(describe, "create_issue")).toBe(describe.create_issue);
});
