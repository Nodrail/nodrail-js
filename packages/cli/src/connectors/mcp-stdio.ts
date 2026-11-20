import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

/** A tool an MCP server offers: its name, input schema and how it runs. */
export type Tool = {
  name: string;
  description: string;
  inputSchema: object;
  call: (input: Record<string, unknown>) => Promise<ToolAnswer>;
};

/** What a tool call gives back: text for the model, flagged when it failed. */
export type ToolAnswer = { text: string; isError?: boolean };

type Request = {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: { name?: unknown; arguments?: unknown; protocolVersion?: unknown };
};

/**
 * A Model Context Protocol server on stdio, as Claude Code and Codex start
 * one: JSON-RPC messages, one per line. Only what a tool server needs:
 * initialize, ping, tools/list and tools/call. Stdout carries the protocol
 * alone; nothing else may be written to it.
 */
export function serveMcp(input: {
  name: string;
  version: string;
  tools: readonly Tool[];
  stdin: Readable;
  stdout: Writable;
}): Promise<void> {
  const send = (message: object) => {
    input.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  };
  const answer = async (request: Request): Promise<void> => {
    const { id, method, params } = request;
    if (id === undefined || id === null) return; // A notification.
    if (method === "initialize")
      return send({
        id,
        result: {
          protocolVersion:
            typeof params?.protocolVersion === "string"
              ? params.protocolVersion
              : "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: input.name, version: input.version },
        },
      });
    if (method === "ping") return send({ id, result: {} });
    if (method === "tools/list")
      return send({
        id,
        result: {
          tools: input.tools.map(({ name, description, inputSchema }) => ({
            name,
            description,
            inputSchema,
          })),
        },
      });
    if (method === "tools/call") {
      const tool = input.tools.find((each) => each.name === params?.name);
      if (!tool)
        return send({
          id,
          error: { code: -32602, message: `No tool ${String(params?.name)}` },
        });
      const args =
        typeof params?.arguments === "object" && params.arguments !== null
          ? (params.arguments as Record<string, unknown>)
          : {};
      const result = await tool.call(args);
      return send({
        id,
        result: {
          content: [{ type: "text", text: result.text }],
          ...(result.isError ? { isError: true } : {}),
        },
      });
    }
    send({ id, error: { code: -32601, message: `No method ${method}` } });
  };
  return new Promise((done) => {
    const pending: Promise<void>[] = [];
    const lines = createInterface({ input: input.stdin });
    lines.on("line", (line) => {
      let request: Request;
      try {
        request = JSON.parse(line) as Request;
      } catch {
        send({ id: null, error: { code: -32700, message: "Not JSON" } });
        return;
      }
      pending.push(answer(request));
    });
    lines.on("close", () => void Promise.all(pending).then(() => done()));
  });
}
