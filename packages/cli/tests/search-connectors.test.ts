// Nodrail's search connectors: two implementations of one search contract,
// so a project can swap one for the other in nodrail.yaml alone.
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage } from "node:http";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { connectorTools } from "../src/commands/connector.ts";
import { serveMcp } from "../src/connectors/mcp-stdio.ts";
import {
  filesBackend,
  httpBackend,
  searchTool,
} from "../src/connectors/search.ts";

const windows = process.platform === "win32";

/** A handbook folder: two collections, a few documents. */
function handbook() {
  const folder = mkdtempSync(join(tmpdir(), "nodrail-handbook-"));
  mkdirSync(join(folder, "public"));
  mkdirSync(join(folder, "internal"));
  writeFileSync(
    join(folder, "public/returns.md"),
    "# Returns\n\nReturns are accepted for 30 days.\n\nShipping takes five days.\n",
  );
  writeFileSync(
    join(folder, "internal/escalation.md"),
    "Returns that need escalation go to queue LANTERN.\n",
  );
  writeFileSync(join(folder, "internal/notes.json"), '{"not":"a document"}');
  return folder;
}

const call = (tool: ReturnType<typeof searchTool>, input: object) =>
  tool.call(input as Record<string, unknown>);

describe("the contract", () => {
  test("both connectors offer the same tool, so one replaces the other", () => {
    const [http] = connectorTools(
      ["http-search", "--endpoint", "http://127.0.0.1:1/search"],
      {},
    );
    const [files] = connectorTools(
      ["files-search", "--folder", handbook()],
      {},
    );
    const shape = (tool: typeof http) => ({
      name: tool!.name,
      description: tool!.description,
      inputSchema: tool!.inputSchema,
    });
    expect(shape(files)).toEqual(shape(http));
    expect(shape(http).name).toBe("search");
  });

  test.each([
    [["http-search"]],
    [["http-search", "--endpoint", "file:///etc/passwd"]],
    [["files-search", "--folder", "x", "--endpoint", "http://a"]],
    [["other"]],
  ])("refuses %j", (args) => {
    expect(() => connectorTools(args, {})).toThrow();
  });

  test("checks the input before searching", async () => {
    let searched = 0;
    const tool = searchTool(async () => (searched++, []));
    for (const input of [
      { collection: "../etc", query: "x" },
      { collection: "public", query: " " },
      { collection: "public", query: "x", limit: 50 },
    ])
      expect(await call(tool, input)).toMatchObject({ isError: true });
    expect(searched).toBe(0);
  });
});

describe("files-search", () => {
  test("finds passages by their words, best first, with their source", async () => {
    const tool = searchTool(filesBackend(handbook()));
    const answer = await call(tool, {
      collection: "public",
      query: "returns days",
    });
    expect(JSON.parse(answer.text)).toEqual({
      matches: [
        {
          collection: "public",
          source: "returns",
          text: "Returns are accepted for 30 days.",
        },
        { collection: "public", source: "returns", text: "# Returns" },
        {
          collection: "public",
          source: "returns",
          text: "Shipping takes five days.",
        },
      ],
    });
    expect(
      JSON.parse(
        (await call(tool, { collection: "public", query: "returns", limit: 1 }))
          .text,
      ).matches,
    ).toHaveLength(1);
  });

  test("an unknown collection is an error the agent sees", async () => {
    const tool = searchTool(filesBackend(handbook()));
    expect(await call(tool, { collection: "secret", query: "x" })).toEqual({
      text: "there is no collection secret",
      isError: true,
    });
  });

  test.skipIf(windows)("a link out of the folder is skipped", async () => {
    const folder = handbook();
    const outside = mkdtempSync(join(tmpdir(), "nodrail-outside-"));
    writeFileSync(join(outside, "leak.md"), "Returns leak here.\n");
    symlinkSync(join(outside, "leak.md"), join(folder, "public/leak.md"));
    const answer = await call(searchTool(filesBackend(folder)), {
      collection: "public",
      query: "leak",
    });
    expect(JSON.parse(answer.text).matches).toEqual([]);
  });

  test("receipts count each read, with its sources and never the query", async () => {
    const receipts = join(
      mkdtempSync(join(tmpdir(), "nodrail-receipts-")),
      "activity",
    );
    const tool = searchTool(filesBackend(handbook(), receipts));
    await call(tool, { collection: "internal", query: "escalation marker-91" });
    const lines = readFileSync(join(receipts, "reads.jsonl"), "utf8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      collection: "internal",
      sources: ["escalation"],
    });
    expect(lines[0]).not.toContain("marker-91");
  });
});

describe("http-search", () => {
  const got: { auth: string; body: unknown }[] = [];
  let answer: (res: import("node:http").ServerResponse) => void = (res) =>
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        matches: [
          { source: "returns-internal", text: "Queue LANTERN." },
          { source: 7, text: "dropped: no source" },
          { source: "two", text: "Second." },
        ],
      }),
    );
  let endpoint = "";
  const server = createServer((req: IncomingMessage, res) => {
    let body = "";
    req.on("data", (chunk) => (body += String(chunk)));
    req.on("end", () => {
      got.push({
        auth: String(req.headers.authorization),
        body: JSON.parse(body),
      });
      answer(res);
    });
  });
  beforeAll(
    () =>
      new Promise<void>((done) =>
        server.listen(0, "127.0.0.1", () => {
          endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/search`;
          done();
        }),
      ),
  );
  afterAll(() => new Promise((done) => server.close(done)));

  test("posts the search with its token and reads the passages back", async () => {
    const tool = searchTool(httpBackend(endpoint, "t0k3n"));
    const result = await call(tool, {
      collection: "internal",
      query: "returns",
      limit: 2,
    });
    expect(got.at(-1)).toEqual({
      auth: "Bearer t0k3n",
      body: { collection: "internal", query: "returns", limit: 2 },
    });
    expect(JSON.parse(result.text).matches).toEqual([
      {
        collection: "internal",
        source: "returns-internal",
        text: "Queue LANTERN.",
      },
    ]);
  });

  test("a failing service is an error the agent sees, without the token", async () => {
    const tool = searchTool(httpBackend(endpoint, "t0k3n"));
    answer = (res) => res.writeHead(401).end();
    expect(await call(tool, { collection: "internal", query: "x" })).toEqual({
      text: "the search service answered 401",
      isError: true,
    });
    answer = (res) => res.writeHead(200).end("not json");
    expect(
      (await call(tool, { collection: "internal", query: "x" })).text,
    ).toBe("the search service answered something that isn't JSON");
    answer = (res) => res.writeHead(200).end("{}");
    expect(
      (await call(tool, { collection: "internal", query: "x" })).text,
    ).toBe("the search service's answer has no matches");
    const gone = searchTool(httpBackend("http://127.0.0.1:1/search", "t0k3n"));
    const down = await call(gone, { collection: "internal", query: "x" });
    expect(down).toEqual({
      text: "the search service can't be reached",
      isError: true,
    });
  });
});

describe("MCP on stdio", () => {
  async function session(lines: (object | string)[]) {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const out: string[] = [];
    stdout.on("data", (data: Buffer) => out.push(data.toString()));
    const served = serveMcp({
      name: "nodrail-files-search",
      version: "9.9.9",
      tools: [searchTool(filesBackend(handbook()))],
      stdin,
      stdout,
    });
    for (const line of lines)
      stdin.write(
        `${typeof line === "string" ? line : JSON.stringify(line)}\n`,
      );
    stdin.end();
    await served;
    return out
      .join("")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  test("answers what hosts ask, and nothing else", async () => {
    const answers = await session([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26" },
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "search",
          arguments: { collection: "internal", query: "lantern" },
        },
      },
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "delete" },
      },
      { jsonrpc: "2.0", id: 5, method: "ping" },
      { jsonrpc: "2.0", id: 6, method: "resources/list" },
      "not json",
    ]);
    const by = (id: number | null) => answers.find((each) => each.id === id);
    expect(by(1)).toMatchObject({
      result: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "nodrail-files-search", version: "9.9.9" },
      },
    });
    expect(
      (by(2)!.result as { tools: { name: string }[] }).tools.map(
        (tool) => tool.name,
      ),
    ).toEqual(["search"]);
    const text = (by(3)!.result as { content: { text: string }[] }).content[0]!
      .text;
    expect(JSON.parse(text).matches[0].source).toBe("escalation");
    expect(by(4)).toMatchObject({ error: { code: -32602 } });
    expect(by(5)).toMatchObject({ result: {} });
    expect(by(6)).toMatchObject({ error: { code: -32601 } });
    expect(by(null)).toMatchObject({ error: { code: -32700 } });
    expect(answers).toHaveLength(7);
  });

  test("`nodrail connector files-search` is that server, as a host starts it", async () => {
    const bin = fileURLToPath(new URL("../src/bin.ts", import.meta.url));
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        bin,
        "connector",
        "files-search",
        "--folder",
        handbook(),
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    child.stdin.end(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search", arguments: { collection: "public", query: "shipping" } } })}\n`,
    );
    let out = "";
    for await (const chunk of child.stdout) out += String(chunk);
    const answer = JSON.parse(out) as {
      result: { content: { text: string }[] };
    };
    expect(JSON.parse(answer.result.content[0]!.text).matches[0].text).toBe(
      "Shipping takes five days.",
    );
  }, 20_000);
});
