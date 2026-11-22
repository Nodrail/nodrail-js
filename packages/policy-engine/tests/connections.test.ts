// Tool connections: MCP servers the setup declares. Both hosts call one as
// `mcp__<connection>__<tool>` through the policy hook, with the subagent that
// made the call, so the hook judges it as that agent before the server runs.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  connectionCall,
  connectionCalls,
  connectionsField,
  type Connections,
} from "../src/connections";
import { cli } from "./run-cli.ts";

const folder = mkdtempSync(join(tmpdir(), "nodrail-connections-"));
const write = (name: string, text: string) => {
  const path = join(folder, name);
  writeFileSync(path, text);
  return path;
};

const declared = connectionsField.parse({
  handbook: {
    command: "node",
    args: ["./connectors/handbook.mjs"],
    env: { HANDBOOK_TOKEN: { fromEnv: "HANDBOOK_TOKEN" } },
    operations: {
      search: { resource: { kind: "collection", from: "collection" } },
      sources: {},
    },
  },
}) as Connections;
const calls = connectionCalls(declared);

describe("declaring a connection", () => {
  test("its call file holds the operations, never the command or a secret", () => {
    expect(JSON.stringify(calls)).not.toContain("HANDBOOK_TOKEN");
    expect(JSON.stringify(calls)).not.toContain("handbook.mjs");
  });

  test.each([
    [
      { shell: { command: "x", operations: { run: {} } } },
      "engine's own tools",
    ],
    [{ docs: { command: "x", operations: { Search: {} } } }, "Lowercase"],
    [{ docs: { command: "x", operations: {} } }, "at least one operation"],
    [
      { docs: { command: "x", operations: { "a-b": {}, a_b: {} } } },
      "differ only by - and _",
    ],
    [
      {
        docs: {
          command: "x",
          env: { T: { fromEnv: "1X" } },
          operations: { a: {} },
        },
      },
      "",
    ],
  ])("refuses %j", (value, message) => {
    const parsed = connectionsField.safeParse(value);
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain(message);
  });
});

describe("reading a call as declared", () => {
  test("the resource comes from the argument the declaration names", () => {
    expect(
      connectionCall(
        "mcp__handbook__search",
        { collection: "internal", query: "returns" },
        calls,
      ),
    ).toMatchObject({
      tool: "handbook",
      operation: "search",
      resource: { kind: "collection", id: "internal" },
    });
  });

  test("an operation without a resource is the tool itself", () => {
    expect(connectionCall("mcp__handbook__sources", {}, calls)).toMatchObject({
      resource: { kind: "mcp_tool", id: "handbook.sources" },
    });
  });

  test.each([
    [
      "mcp__handbook__delete",
      {},
      "delete isn't an operation connection handbook declares",
    ],
    [
      "mcp__handbook__search",
      { query: "x" },
      "handbook search needs collection, the collection it acts on",
    ],
    ["mcp__handbook__search", { collection: 7 }, "needs collection"],
  ])("%s %j is refused", (name, input, reason) => {
    expect(connectionCall(name, input, calls)).toContain(reason);
  });

  test("Codex's names, with `_` for `-`, are the declared ones", () => {
    const named = connectionCalls(
      connectionsField.parse({
        "support-memory": { command: "x", operations: { "search-nodes": {} } },
      }) as Connections,
    );
    // Codex 0.170.0 calls `support-memory` as `mcp__support_memory__…`.
    expect(
      connectionCall("mcp__support_memory__search_nodes", {}, named),
    ).toMatchObject({
      tool: "support-memory",
      operation: "search-nodes",
      resource: { kind: "mcp_tool", id: "support-memory.search-nodes" },
    });
    expect(
      connectionCall("mcp__support-memory__search-nodes", {}, named),
    ).toMatchObject({
      tool: "support-memory",
    });
    expect(connectionCall("mcp__support_memory__delete", {}, named)).toBe(
      "delete isn't an operation connection support-memory declares",
    );
  });

  test("any other call is left to the host's own tools", () => {
    expect(connectionCall("mcp__github__issues", {}, calls)).toBeNull();
    expect(connectionCall("Bash", { command: "ls" }, calls)).toBeNull();
  });
});

describe("the hook with --connections", () => {
  const file = write(
    "connections.json",
    JSON.stringify({ connections: calls }),
  );
  const rules = write(
    "rules.yaml",
    `- rule: Public handbook for everyone
  tool: handbook
  operation: search
  resource: { kind: collection, match: exact, value: public }
  effect: allow
- rule: Internal handbook for support
  agent: support
  tool: handbook
  operation: search
  resource: { kind: collection, match: exact, value: internal }
  effect: allow
`,
  );
  const search = (collection: string, extra: object = {}) =>
    JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "mcp__handbook__search",
      tool_input: { collection, query: "returns", ...extra },
      ...extra,
    });
  const hook = (stdin: string) =>
    cli(["hook", rules, "--connections", file, "--agent", "marketing"], stdin);

  test("marketing is denied, its support subagent allowed, marketing denied again", async () => {
    expect((await hook(search("internal"))).stdout).toContain('"deny"');
    expect(
      await hook(search("internal", { agent_type: "support" })),
    ).toMatchObject({ code: 0, stdout: "" });
    expect((await hook(search("internal"))).stdout).toContain('"deny"');
    expect(await hook(search("public"))).toMatchObject({ stdout: "" });
  });

  test("an agent named in the arguments changes nothing", async () => {
    const result = await hook(
      JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "mcp__handbook__search",
        tool_input: { collection: "internal", query: "x", agent: "support" },
      }),
    );
    expect(result.stdout).toContain('"deny"');
  });

  test("a call it can't read as declared is blocked, with the reason", async () => {
    const result = await hook(
      JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "mcp__handbook__search",
        tool_input: { query: "x" },
      }),
    );
    expect(result.stdout).toContain(
      "handbook search needs collection, the collection it acts on",
    );
  });

  test("a connections file that can't be read blocks with exit 2", async () => {
    for (const path of [
      join(folder, "missing.json"),
      write("bad.json", "{}"),
    ]) {
      const result = await cli(
        ["hook", rules, "--connections", path],
        search("public"),
      );
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("can't read the connections");
    }
  });
});

// A connection's data, such as a memory file, is reached only through the
// connection: its rules say which agent may read or change what it keeps,
// and a file tool or the shell would go around them.
describe("a connection's data", () => {
  const keepsData = (path: string) =>
    connectionsField.safeParse({
      m: { command: "x", operations: { a: {} }, data: [path] },
    }).success;

  test.each([["./memory"], ["./memory/support.jsonl"], ["./.data/x"]])(
    "%s is a data path",
    (path) => expect(keepsData(path)).toBe(true),
  );

  test.each([
    ["memory"],
    ["/abs"],
    ["./../out"],
    ["./a/../b"],
    ["./a/*"],
    ["./"],
    ["./a//b"],
  ])("%s is refused", (path) => expect(keepsData(path)).toBe(false));

  // The project: .nodrail/connections.json, and memory/ beside it.
  const project = mkdtempSync(join(tmpdir(), "nodrail-data-"));
  mkdirSync(join(project, ".nodrail"));
  mkdirSync(join(project, "memory"));
  writeFileSync(join(project, "memory/support.jsonl"), "{}\n");
  const file = join(project, ".nodrail/connections.json");
  writeFileSync(
    file,
    JSON.stringify({
      connections: {
        "support-memory": {
          operations: { search_nodes: {} },
          data: ["./memory/support.jsonl"],
        },
      },
    }),
  );
  const open = write(
    "open.yaml",
    `- rule: Read anything
  tool: files
  operation: file.read
  resource: { kind: file, match: any }
  effect: allow
- rule: Search anything
  tool: files
  operation: file.search
  resource: { kind: file, match: any }
  effect: allow
- rule: Listing
  command: ls
  effect: allow
- rule: Cat
  command: { prefix: "cat " }
  effect: allow
- rule: Grep
  command: { prefix: "grep " }
  effect: allow
- rule: Memory for all
  tool: support-memory
  operation: search_nodes
  resource: { kind: mcp_tool, match: any }
  effect: allow
`,
  );
  const call = (tool_name: string, tool_input: object) =>
    cli(
      ["hook", open, "--connections", file],
      JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name,
        tool_input,
        cwd: project,
      }),
    );

  test.each([
    ["Read", { file_path: join(project, "memory/support.jsonl") }],
    [
      "Write",
      { file_path: join(project, "memory/support.jsonl"), content: "x" },
    ],
    ["Grep", { pattern: "HERON", path: join(project, "memory") }],
    ["Bash", { command: "cat memory/support.jsonl" }],
    ["Bash", { command: "grep -r HERON memory" }],
    ["Bash", { command: "cat memory/*" }],
  ])("%s %j is denied, whatever the rules say", async (tool, input) => {
    const result = await call(tool, input);
    expect(result.stdout).toContain('"deny"');
    expect(result.stdout).toContain(
      "holds the data of connection support-memory",
    );
  });

  test.each([
    ["mcp__support-memory__search_nodes", { query: "x" }],
    ["Read", { file_path: join(project, "memory/other.txt") }],
    ["Bash", { command: "ls" }],
    ["Grep", { pattern: "x", path: project }],
  ])("%s %j is left to the rules", async (tool, input) => {
    expect(await call(tool, input)).toEqual({
      code: 0,
      stdout: "",
      stderr: "",
    });
  });

  test("a long run of glob characters is cut in linear time", async () => {
    // CodeQL js/polynomial-redos flagged the old cut; it is linear by construction now.
    const started = performance.now();
    const result = await call("Bash", {
      command: `cat ${"*".repeat(100_000)}`,
    });
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(result.stdout).not.toContain("holds the data of connection");
  });
});
