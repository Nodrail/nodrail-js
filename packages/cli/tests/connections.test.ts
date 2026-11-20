// Tool connections set up by `nodrail plan` and `apply`: each host starts
// them with `nodrail connection run`, the hook reads their calls as
// declared, and a secret is only ever named, never written.
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { startConnection } from "../src/commands/connection.ts";
import { CONNECTIONS_FILE, pinChecks } from "../src/setup/connections.ts";
import {
  codexTools,
  filesUnder,
  locked,
  RESOURCES,
  windows,
} from "./support/setup-project.ts";

const SECRET = "marker-7f3a-not-for-files";

/**
 * A connector as small as MCP allows: `search` and `sources`. It records the
 * names of the environment it got, and each call it receives.
 */
const CONNECTOR = `const { appendFileSync } = require("node:fs");
const { createInterface } = require("node:readline");
const log = (entry) => appendFileSync("receipts.jsonl", JSON.stringify(entry) + "\\n");
log({ started: Object.keys(process.env).sort(), token: (process.env.HANDBOOK_TOKEN ?? "").length, data: process.env.HANDBOOK_DATA, cwd: process.cwd() });
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "handbook", version: "1" } } });
  else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: [
    { name: "search", inputSchema: { type: "object", properties: { collection: { type: "string" }, query: { type: "string" } } } },
    { name: "sources", inputSchema: { type: "object", properties: {} } } ] } });
  else if (m.method === "tools/call") { log({ call: m.params }); send({ jsonrpc: "2.0", id: m.id, result: { content: [] } }); }
});
`;

const connection = (
  operations = "search: { resource: { kind: collection, from: collection } }",
) => `connections:
  handbook:
    command: ${JSON.stringify(process.execPath)}
    args: [./connectors/handbook.cjs]
    env:
      HANDBOOK_TOKEN: { fromEnv: HANDBOOK_TOKEN }
      HANDBOOK_MODE: plain
      HANDBOOK_DATA: ./data/handbook.jsonl
    operations:
      ${operations}
`;

const files = (extra = connection()) => ({
  ...RESOURCES,
  "connectors/handbook.cjs": CONNECTOR,
  "nodrail.yaml": `${RESOURCES["nodrail.yaml"]}${extra}`,
});

/** Every file under the folder whose bytes hold the text. */
const holding = (root: string, text: string) =>
  Object.entries(filesUnder(root))
    .filter(([, bytes]) => bytes.includes(text))
    .map(([path]) => path);

async function desk(extra?: string, runtime = "claude-code") {
  const bin = runtime === "codex" ? codexTools() : undefined;
  const nodrail = files(extra);
  if (runtime === "codex")
    nodrail["nodrail.yaml"] = nodrail["nodrail.yaml"].replace(
      "runtime: claude-code",
      "runtime: codex",
    );
  const p = await locked(nodrail, bin);
  p.env.HANDBOOK_TOKEN = SECRET;
  p.env.OTHER_SECRET = "never-passed-on";
  return p;
}

describe.skipIf(windows)("connections on Claude Code", () => {
  // The regression for "plan runs code from the repository with the
  // person's secrets": the connector records each start.
  const starts = (p: { cwd: string; read: (path: string) => string }) =>
    existsSync(join(p.cwd, "receipts.jsonl"))
      ? p
          .read("receipts.jsonl")
          .split("\n")
          .filter((line) => line.includes('"started"')).length
      : 0;

  test("plan shows what each connection runs and gets, and starts nothing", async () => {
    const p = await desk();
    const { code, out } = await p.run("plan");
    expect(code).toBe(0);
    expect(out).toContain(
      "✓ secret HANDBOOK_TOKEN: set; given only to connection handbook",
    );
    expect(out).toContain(
      "Connections (not started: apply starts each once to check it, after you accept)",
    );
    expect(out).toContain(
      `handbook: runs ${process.execPath} ./connectors/handbook.cjs; with HANDBOOK_TOKEN (secret HANDBOOK_TOKEN), HANDBOOK_MODE, HANDBOOK_DATA=./data/handbook.jsonl`,
    );
    expect(out).toMatch(/\+ \.mcp\.json\s+the connections handbook/);
    expect(out).not.toContain(SECRET);
    expect(starts(p)).toBe(0);
    const json = await p.run("plan", "--json");
    expect(JSON.parse(json.out).connections).toEqual([
      expect.stringContaining("handbook: runs "),
    ]);
    expect(starts(p)).toBe(0);
  });

  test("a missing secret blocks, and nothing starts", async () => {
    const p = await desk();
    delete p.env.HANDBOOK_TOKEN;
    const { code, out } = await p.run("plan");
    expect(code).toBe(1);
    expect(out).toContain(
      "! secret HANDBOOK_TOKEN: missing; connection handbook needs it",
    );
    expect((await p.run("apply", "--yes")).code).toBe(1);
    expect(starts(p)).toBe(0);
  });

  test("apply starts a connection only once the person accepts the plan", async () => {
    const p = await desk();
    const answering = async (answer: string) => {
      const { fakeIo } = await import("./support/fake-io.ts");
      const terminal = fakeIo({
        cwd: p.cwd,
        home: p.home,
        env: p.env,
        interactive: true,
        answers: [answer],
      });
      const code = await terminal.run("apply");
      return { code, out: terminal.stdout() };
    };
    const declined = await answering("n");
    expect(declined.out).toContain("Nothing was changed.");
    expect(starts(p)).toBe(0);
    const accepted = await answering("y");
    expect(accepted.code).toBe(0);
    expect(accepted.out).toContain("✓ connection handbook: offers search");
    expect(starts(p)).toBe(1);
    expect(p.read("receipts.jsonl")).not.toContain('"call"');
    expect(existsSync(join(p.cwd, ".mcp.json"))).toBe(true);
  });

  test("a connector that doesn't offer a declared operation stops apply before any write", async () => {
    const p = await desk(connection("lookup: {}"));
    const { code, err } = await p.run("apply", "--yes");
    expect(code).toBe(1);
    expect(err).toContain(
      "Nothing was changed: connection handbook doesn't match its declaration: no tool lookup.",
    );
    expect(existsSync(join(p.cwd, ".mcp.json"))).toBe(false);
    expect(existsSync(join(p.cwd, ".nodrail"))).toBe(false);
  });

  test("apply declares the connection natively, and no file holds the secret", async () => {
    const p = await desk();
    expect((await p.run("apply", "--yes")).code).toBe(0);
    const mcp = JSON.parse(p.read(".mcp.json")) as {
      mcpServers: Record<
        string,
        { command: string; args: string[]; env: object }
      >;
    };
    expect(mcp.mcpServers.handbook).toMatchObject({
      command: "nodrail",
      args: [
        "connection",
        "run",
        expect.stringMatching(/\.nodrail\/connections\.json$/),
        "handbook",
      ],
      env: { HANDBOOK_TOKEN: "${HANDBOOK_TOKEN}" },
    });
    const settings = JSON.parse(p.read(".claude/settings.json")) as {
      enabledMcpjsonServers: string[];
      hooks: { PreToolUse: { hooks: { command: string }[] }[] };
    };
    expect(settings.enabledMcpjsonServers).toEqual(["handbook"]);
    expect(settings.hooks.PreToolUse[0]!.hooks[0]!.command).toContain(
      '--connections "$CLAUDE_PROJECT_DIR/.nodrail/connections.json"',
    );
    expect(p.read(".nodrail/protected.txt")).toContain(
      "connectors/handbook.cjs",
    );
    expect(holding(p.cwd, SECRET)).toEqual([]);
  });

  test("the person's own servers stay, and one with the same name is a conflict", async () => {
    const p = await desk();
    p.write(
      ".mcp.json",
      JSON.stringify({ mcpServers: { mine: { command: "x" } } }),
    );
    p.write(
      ".claude/settings.json",
      JSON.stringify({ enabledMcpjsonServers: ["mine"] }),
    );
    expect((await p.run("apply", "--yes")).code).toBe(0);
    expect(Object.keys(JSON.parse(p.read(".mcp.json")).mcpServers)).toEqual([
      "mine",
      "handbook",
    ]);
    expect(
      JSON.parse(p.read(".claude/settings.json")).enabledMcpjsonServers,
    ).toEqual(["mine", "handbook"]);
    // The connection goes: only nodrail's entries are taken out.
    p.write("nodrail.yaml", RESOURCES["nodrail.yaml"]);
    expect((await p.run("policy", "lock")).code).toBe(0);
    expect((await p.run("apply", "--yes")).code).toBe(0);
    expect(JSON.parse(p.read(".mcp.json")).mcpServers).toEqual({
      mine: { command: "x" },
    });
    expect(
      JSON.parse(p.read(".claude/settings.json")).enabledMcpjsonServers,
    ).toEqual(["mine"]);

    const other = await desk();
    other.write(
      ".mcp.json",
      JSON.stringify({ mcpServers: { handbook: { command: "x" } } }),
    );
    const { code, out } = await other.run("plan");
    expect(code).toBe(1);
    expect(out).toContain(
      "a server named handbook is there, not written by nodrail",
    );
  });
});

describe.skipIf(windows)("a connection's data", () => {
  const keeping = connection().replace(
    "    operations:",
    "    data: [./data]\n    operations:",
  );

  test("plan shows it, apply records it, and it outlives the connection", async () => {
    const p = await desk(keeping);
    const planned = await p.run("plan");
    expect(planned.out).toContain(
      "HANDBOOK_DATA=./data/handbook.jsonl; keeps ./data, which agents reach only through it",
    );
    expect((await p.run("apply", "--yes")).code).toBe(0);
    expect(
      JSON.parse(p.read(".nodrail/connections.json")).connections.handbook.data,
    ).toEqual(["./data"]);
    // What the connection writes as it runs changes nothing nodrail reviewed.
    p.write("data/handbook.jsonl", '{"fact":"HERON-417"}\n');
    expect((await p.run("plan")).out).toContain("Nothing to change.");

    p.write("nodrail.yaml", RESOURCES["nodrail.yaml"]);
    expect((await p.run("policy", "lock")).code).toBe(0);
    expect((await p.run("plan")).out).toContain(
      "Connection handbook is gone from nodrail.yaml: apply removes it, and keeps its data at ./data, which agents can then reach with file tools. Move or delete it yourself if they shouldn't.",
    );
    expect((await p.run("apply", "--yes")).code).toBe(0);
    expect(p.read("data/handbook.jsonl")).toContain("HERON-417");
    expect(JSON.parse(p.read(".mcp.json")).mcpServers).toEqual({});
  });
});

describe("a connection a package runner fetches", () => {
  const check = (command: string, args: string[]) =>
    pinChecks({
      connections: [
        {
          name: "memory",
          spec: { command, args, env: {}, operations: { a: {} } },
          files: [],
        },
      ],
    });

  test.each([
    ["npx", ["-y", "@modelcontextprotocol/server-memory@2.2.1"]],
    ["npx", ["--package=@scope/tool@1.0.0-beta.2", "tool"]],
    ["uvx", ["mcp-server-fetch==2025.4.7"]],
    ["/usr/local/bin/bunx", ["pkg@3.1.4"]],
  ])("%s %j is pinned", (command, args) => {
    expect(check(command, args)).toEqual([
      expect.objectContaining({
        ok: true,
        detail: expect.stringContaining("an exact version"),
      }),
    ]);
  });

  test.each([
    ["npx", ["-y", "@modelcontextprotocol/server-memory"]],
    ["npx", ["-y", "@modelcontextprotocol/server-memory@latest"]],
    ["npx", ["pkg@^2.0.0"]],
    ["uvx", ["mcp-server-fetch"]],
  ])("%s %j is marked unverified, with how to pin it", (command, args) => {
    expect(check(command, args)).toEqual([
      expect.objectContaining({
        ok: true,
        unverified: true,
        detail: expect.stringContaining("no exact version"),
      }),
    ]);
  });

  test("a program it doesn't fetch isn't checked", () => {
    expect(check("node", ["./server.js"])).toEqual([]);
  });
});

describe.skipIf(windows)("connections on Codex", () => {
  test("each is an MCP server in the project's config, its secrets passed by name", async () => {
    const p = await desk(undefined, "codex");
    await p.run("apply", "--yes");
    const config = p.read(".codex/config.toml");
    expect(config).toContain('[mcp_servers."handbook"]\ncommand = "nodrail"');
    expect(config).toContain('env_vars = ["HANDBOOK_TOKEN"]');
    expect(p.read(".codex/hooks.json")).toContain("--connections ");
    expect(holding(p.cwd, SECRET)).toEqual([]);
  });
});

describe.skipIf(windows)("nodrail connection run", () => {
  test("starts the connection in the project with its secrets and nothing else", async () => {
    const p = await desk();
    await p.run("apply", "--yes");
    const child = startConnection(
      join(p.cwd, CONNECTIONS_FILE),
      "handbook",
      { ...p.env, PATH: process.env.PATH! },
      ["pipe", "pipe", "ignore"],
    );
    child.stdin!.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`,
    );
    await new Promise((done) => child.stdout!.once("data", done));
    child.kill();
    const started = JSON.parse(p.read("receipts.jsonl").split("\n")[0]!) as {
      started: string[];
      token: number;
      data: string;
      cwd: string;
    };
    expect(started.token).toBe(SECRET.length);
    expect(started.started).toContain("HANDBOOK_MODE");
    expect(started.started).not.toContain("OTHER_SECRET");
    expect(realpathSync(started.cwd)).toBe(realpathSync(p.cwd));
    // Whole, so a server that resolves against its install folder still
    // keeps its data in the project.
    const tail = "/data/handbook.jsonl";
    expect(started.data.endsWith(tail)).toBe(true);
    expect(realpathSync(started.data.slice(0, -tail.length))).toBe(
      realpathSync(p.cwd),
    );
  });

  test("a missing secret stops it with the name, never a value", async () => {
    const p = await desk();
    await p.run("apply", "--yes");
    const env = { ...p.env };
    delete env.HANDBOOK_TOKEN;
    expect(() =>
      startConnection(join(p.cwd, CONNECTIONS_FILE), "handbook", env),
    ).toThrow("HANDBOOK_TOKEN isn't set");
  });
});
