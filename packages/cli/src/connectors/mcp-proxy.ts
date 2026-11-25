// The client side of MCP on stdio: Nodrail starts a provider's own MCP
// server and calls it, so a connection to any provider can be mediated
// (mediate.ts). Only what a tool client needs: initialize, tools/list and
// tools/call. A call is sent once; Nodrail never sends it again.
import type { ChildProcessByStdio } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { spawn } from "../spawn.js";
import {
  mediateTools,
  ProviderUnavailable,
  type MediateOptions,
} from "./mediate.ts";
import { serveMcp, type Tool, type ToolAnswer } from "./mcp-stdio.ts";

export type UpstreamCommand = {
  command: string;
  args: readonly string[];
  /** The provider's whole environment: pass what it needs, nothing more. */
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** How long a call may take before its outcome counts as unknown. */
  callTimeoutMs?: number;
  client?: { name: string; version: string };
};

/** A provider's tools, and how to stop it. */
export type Upstream = { tools: Tool[]; close: () => void };

/** The provider stopped answering: whether a call took effect is unknown. */
export class OutcomeUnknown extends Error {}

/** The provider answered with a JSON-RPC error. */
class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type Message = {
  id?: number | string | null;
  method?: string;
  result?: unknown;
  error?: { code?: unknown; message?: unknown };
};

const START_TIMEOUT = 30_000;
const CALL_TIMEOUT = 120_000;
const MAX_PAGES = 20;
const MESSAGE = 500;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** JSON-RPC over a provider's stdio, one message per line. */
class Rpc {
  private readonly pending = new Map<number, Pending>();
  private next = 0;
  private gone: string | null = null;

  constructor(
    private readonly child: ChildProcessByStdio<Writable, Readable, null>,
  ) {
    child.on("error", () => this.fail("the provider couldn't be started"));
    child.on("exit", () => this.fail("the provider exited"));
    child.stdin.on("error", () => this.fail("the provider closed its input"));
    createInterface({ input: child.stdout }).on("line", (line) =>
      this.receive(line),
    );
  }

  /** Every call still waiting gets no answer: its outcome is unknown. */
  private fail(why: string) {
    this.gone ??= why;
    for (const [id, each] of this.pending) {
      clearTimeout(each.timer);
      each.reject(new OutcomeUnknown(why));
      this.pending.delete(id);
    }
  }

  private write(message: object) {
    if (this.gone) return;
    this.child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`,
    );
  }

  private receive(line: string) {
    let message: Message;
    try {
      message = JSON.parse(line) as Message;
    } catch {
      return; // Not the protocol: ignored, as a host would.
    }
    if (message.method !== undefined) return this.answer(message);
    const id = message.id;
    const waiting = typeof id === "number" ? this.pending.get(id) : undefined;
    if (!waiting) return;
    this.pending.delete(id as number);
    clearTimeout(waiting.timer);
    const { error } = message;
    if (!error) return waiting.resolve(message.result);
    waiting.reject(
      new RpcError(
        typeof error.code === "number" ? error.code : -32603,
        (typeof error.message === "string" ? error.message : "").slice(
          0,
          MESSAGE,
        ),
      ),
    );
  }

  /** A request from the provider: only ping is answered. */
  private answer({ id, method }: Message) {
    if (id === undefined || id === null) return;
    if (method === "ping") return this.write({ id, result: {} });
    this.write({
      id,
      error: { code: -32601, message: "Not supported by this client" },
    });
  }

  notify(method: string) {
    this.write({ method });
  }

  request(method: string, params: object, timeout: number) {
    return new Promise<unknown>((resolve, reject) => {
      // Never sent, so certainly not run.
      if (this.gone) return reject(new ProviderUnavailable(this.gone));
      const id = ++this.next;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new OutcomeUnknown("the provider didn't answer in time"));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }

  close() {
    this.fail("closed");
    this.child.stdin.end();
    if (this.child.exitCode === null) this.child.kill();
  }
}

/** A tools/call result as a tool answer, its blocks kept as they came. */
function answerOf(result: unknown): ToolAnswer {
  const answer = isRecord(result) ? result : {};
  const content = Array.isArray(answer.content) ? answer.content : [];
  const text = content
    .map((block) =>
      isRecord(block) && block.type === "text" && typeof block.text === "string"
        ? block.text
        : "",
    )
    .join("\n");
  return {
    text,
    content,
    ...(answer.isError === true ? { isError: true } : {}),
    ...(isRecord(answer.structuredContent)
      ? { structuredContent: answer.structuredContent }
      : {}),
  };
}

/** One of the provider's tools, calling it through rpc. */
function upstreamTool(
  rpc: Rpc,
  spec: Record<string, unknown>,
  timeout: number,
): Tool {
  const name = spec.name as string;
  return {
    name,
    description: typeof spec.description === "string" ? spec.description : "",
    inputSchema: isRecord(spec.inputSchema)
      ? spec.inputSchema
      : { type: "object" },
    ...(isRecord(spec.outputSchema) ? { outputSchema: spec.outputSchema } : {}),
    call: async (args) => {
      try {
        return answerOf(
          await rpc.request("tools/call", { name, arguments: args }, timeout),
        );
      } catch (error) {
        if (!(error instanceof RpcError)) throw error;
        return {
          text: `the provider answered error ${error.code}: ${error.message}`,
          isError: true,
        };
      }
    },
  };
}

/** Every page of tools/list, up to a bound. */
async function listTools(rpc: Rpc) {
  const listed: Record<string, unknown>[] = [];
  let cursor: unknown;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await rpc.request(
      "tools/list",
      cursor === undefined ? {} : { cursor },
      START_TIMEOUT,
    );
    const tools = isRecord(result) ? result.tools : undefined;
    if (Array.isArray(tools))
      listed.push(
        ...tools.filter(
          (tool): tool is Record<string, unknown> =>
            isRecord(tool) && typeof tool.name === "string",
        ),
      );
    cursor = isRecord(result) ? result.nextCursor : undefined;
    if (typeof cursor !== "string") break;
  }
  return listed;
}

/**
 * Starts the provider, initializes it and lists its tools. Each tool calls
 * the provider; a call that gets no answer, because the provider exited or
 * timed out, throws OutcomeUnknown, and one that can't be sent because the
 * provider is gone throws ProviderUnavailable.
 */
export async function connectUpstream(
  input: UpstreamCommand,
): Promise<Upstream> {
  const rpc = new Rpc(
    spawn(input.command, [...input.args], {
      cwd: input.cwd,
      env: input.env ?? {},
      // Stdout is the protocol; the provider's own messages go to our stderr.
      stdio: ["pipe", "pipe", "inherit"],
    }),
  );
  try {
    await rpc.request(
      "initialize",
      {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: input.client ?? { name: "nodrail", version: "0" },
      },
      START_TIMEOUT,
    );
    rpc.notify("notifications/initialized");
    const timeout = input.callTimeoutMs ?? CALL_TIMEOUT;
    const tools = (await listTools(rpc)).map((spec) =>
      upstreamTool(rpc, spec, timeout),
    );
    return { tools, close: () => rpc.close() };
  } catch (error) {
    rpc.close();
    throw error instanceof OutcomeUnknown ||
      error instanceof ProviderUnavailable
      ? new Error(`The provider didn't start: ${error.message}`)
      : error;
  }
}

/**
 * A mediated connection to a provider's own MCP server: the agent's host
 * starts this, this starts the provider, and every call goes through
 * mediateTools on the way. Serves until the host closes stdin.
 */
export async function serveMediatedProxy(input: {
  name: string;
  version: string;
  upstream: UpstreamCommand;
  mediate: MediateOptions;
  stdin: Readable;
  stdout: Writable;
}): Promise<void> {
  const upstream = await connectUpstream({
    ...input.upstream,
    client: input.upstream.client ?? {
      name: input.name,
      version: input.version,
    },
  });
  try {
    await serveMcp({
      name: input.name,
      version: input.version,
      tools: mediateTools(upstream.tools, input.mediate),
      stdin: input.stdin,
      stdout: input.stdout,
    });
  } finally {
    upstream.close();
  }
}
