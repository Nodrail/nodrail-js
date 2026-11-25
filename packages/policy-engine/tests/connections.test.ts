// Tool connections: MCP servers the setup declares. Both hosts call one as
// `mcp__<connection>__<tool>` through the policy hook, with the subagent that
// made the call, so the hook judges it as that agent before the server runs.
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
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
  afterAll(() => rmSync(project, { recursive: true, force: true }));
  mkdirSync(join(project, ".nodrail"));
  mkdirSync(join(project, "memory"));
  writeFileSync(join(project, "memory/support.jsonl"), "{}\n");
  symlinkSync(
    join(project, "memory/support.jsonl"),
    join(project, "memory/current.txt"),
    "file",
  );
  symlinkSync(
    join(project, "memory/support.jsonl"),
    join(project, "memory/A-link.txt"),
    "file",
  );
  mkdirSync(join(project, "snapshots"));
  symlinkSync(
    join(project, "memory"),
    join(project, "snapshots/today"),
    "junction",
  );
  symlinkSync(
    join(project, "memory/pending.jsonl"),
    join(project, "snapshots/pending.txt"),
    "file",
  );
  const file = join(project, ".nodrail/connections.json");
  writeFileSync(
    file,
    JSON.stringify({
      connections: {
        "support-memory": {
          operations: { search_nodes: {} },
          data: ["./memory/support.jsonl", "./memory/pending.jsonl"],
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
- rule: Remove
  command: { prefix: "rm " }
  effect: allow
- rule: Allow these brace alternatives
  tool: shell
  operation: command.compound
  resource: { kind: command, match: exact, value: "cat memory/{logs,other}.jsonl" }
  effect: allow
- rule: Allow a letter sequence
  tool: shell
  operation: command.compound
  resource: { kind: command, match: exact, value: "cat memory/suppor{s..v}.jsonl" }
  effect: allow
- rule: Allow a numeric sequence
  tool: shell
  operation: command.compound
  resource: { kind: command, match: exact, value: "cat memory/{03..01..1}.jsonl" }
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
  const call = (tool_name: string, tool_input: object, connections = file) =>
    cli(
      ["hook", open, "--connections", connections],
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
    ["Bash", { command: "cat memory/sup*.jsonl" }],
    ["Bash", { command: "cat memory/suppor?.jsonl" }],
    ["Bash", { command: "cat memory/suppor[s-v].jsonl" }],
    ["Bash", { command: "cat memory/cur*.txt" }],
    ["Bash", { command: "cat memory/[!a]-li*.txt" }],
    ["Bash", { command: "cat snapshots/t*/sup*.jsonl" }],
    ["Bash", { command: "cat snapshots/**/cur*.txt" }],
    ["Bash", { command: "cat snapshots/t*/support.jsonl" }],
    ["Bash", { command: "cat mem*/./support.jsonl" }],
    ["Bash", { command: "cat memory/{support,other}.jsonl" }],
    ["Bash", { command: "cat {memory,logs}/sup*.jsonl" }],
    ["Bash", { command: "cat **/sup*.jsonl" }],
    ["Bash", { command: "cat memory/**/sup*.jsonl" }],
    ["Bash", { command: `cat "${join(project, "memory", "sup*.jsonl")}"` }],
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
    ["Bash", { command: "rm *.log" }],
    ["Bash", { command: "rm **/*.log" }],
    ["Bash", { command: "cat *.jsonl" }],
    ["Bash", { command: "cat memory/{logs,other}.jsonl" }],
    ["Bash", { command: "cat memory/suppor[a-c].jsonl" }],
    ["Bash", { command: "cat memory/sup*.log" }],
    ["Bash", { command: "cat memory/sup*.jsonl/child" }],
    ["Grep", { pattern: "x", path: project }],
  ])("%s %j is left to the rules", async (tool, input) => {
    expect(await call(tool, input)).toEqual({
      code: 0,
      stdout: "",
      stderr: "",
    });
  });

  test("a matching dangling link is attributed to its protected destination", async () => {
    const result = await call("Bash", {
      command: "cat snapshots/pending*.txt",
    });
    expect(result.stdout).toContain(
      "pending.jsonl holds the data of connection support-memory",
    );
  });

  test.each(["cat memory/suppor{s..v}.jsonl", "cat memory/{03..01..1}.jsonl"])(
    "the guard refuses unsupported brace sequences in %s",
    async (command) => {
      const result = await call("Bash", { command });
      expect(result.stdout).toContain("holds the data of connection");
    },
  );

  test.each([
    ["parent navigation", "absent*/../public.txt"],
    [
      "too many segments once joined to the project",
      `${"./".repeat(254)}absent*`,
    ],
  ])(
    "refuses a wildcard with %s even with no matches",
    async (_reason, pattern) => {
      const result = await call("Bash", { command: `cat ${pattern}` });
      expect(result.stdout).toContain("holds the data of connection");
    },
  );

  test("a glob matching a protected directory also guards its uncreated children", async () => {
    mkdirSync(join(project, "vault"));
    const directories = join(project, ".nodrail/directories.json");
    writeFileSync(
      directories,
      JSON.stringify({
        connections: {
          "support-memory": {
            operations: { search_nodes: {} },
            data: ["./vault"],
          },
        },
      }),
    );
    const result = await call(
      "Bash",
      { command: "cat v?ult/./nested/item" },
      directories,
    );
    expect(result.stdout).toContain("holds the data of connection");
  });

  test("refuses a glob with more results than the guard can inspect", async () => {
    const large = join(project, "large");
    mkdirSync(large);
    try {
      for (let index = 0; index < 500; index += 1)
        writeFileSync(join(large, `entry-${index}.txt`), "");
      const input = { command: "cat large/entry-*.txt" };
      expect((await call("Bash", input)).stdout).toBe("");
      const costly = await call("Bash", {
        command: `cat large/entry-${"?".repeat(512)}.log`,
      });
      expect(costly.stdout).toContain("holds the data of connection");
      writeFileSync(join(large, "entry-500.txt"), "");
      const result = await call("Bash", input);
      expect(result.stdout).toContain("holds the data of connection");
    } finally {
      rmSync(large, { recursive: true, force: true });
    }
  });

  test.each([
    ["a long run of stars", "*".repeat(100_000)],
    ["an overlong suffix", `*${"/missing".repeat(12_000)}`],
    ["an overly deep suffix below the length limit", `*${"/x".repeat(1800)}`],
  ])("rejects %s within the CPU budget", async (_name, pattern) => {
    const started = process.cpuUsage();
    const result = await call("Bash", {
      command: `cat ${pattern}`,
    });
    const { user, system } = process.cpuUsage(started);
    expect((user + system) / 1000).toBeLessThan(2_000);
    expect(result.stdout).toContain("holds the data of connection");
  });
});
