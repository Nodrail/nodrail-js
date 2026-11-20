// Plugins a setup ships with: a folder in the project each host loads, and
// the operations of the MCP servers it brings. The hook reads a plugin's
// tool calls as Claude Code and Codex each name them, and a Team's rules say
// who may use which plugin and load its skills.
import { describe, expect, test } from "vitest";
import { describeToolCall } from "../src/actions";
import { connectionCall } from "../src/connections";
import { toDescriptor } from "../src/local-hook";
import { simulate } from "../src/simulator";
import {
  compilePolicies,
  pluginCalls,
  resolveProject,
  type Plugins,
} from "../src/yaml";
import { memoryHost } from "./support/project-host";

const api = "apiVersion: apf.nodrail.com/v1alpha1";
const resources = [
  `${api}\nkind: Agent\nmetadata: { name: marketing }`,
  `${api}\nkind: Agent\nmetadata: { name: support }`,
  `${api}\nkind: Team\nmetadata: { name: desk }\nspec: { entry: marketing, members: [marketing, support], handoffs: [{ from: marketing, to: support }] }`,
].join("\n---\n");

const KIT = {
  "vendor/desk-kit/.claude-plugin/plugin.json":
    '{"name":"desk-kit","version":"0.1.0"}',
  "vendor/desk-kit/.mcp.json": '{"mcpServers":{"ledger":{"command":"node"}}}',
  "vendor/desk-kit/.codex-plugin/plugin.json":
    '{"name":"desk-kit","version":"0.1.0","mcpServers":"./.codex.mcp.json"}',
  "vendor/desk-kit/.codex.mcp.json":
    '{"mcpServers":{"ledger":{"command":"node","cwd":"."}}}',
  "vendor/desk-kit/skills/desk-greeting/SKILL.md":
    "---\nname: desk-greeting\n---\n",
};

const PLUGINS = `plugins:
  desk-kit:
    source: ./vendor/desk-kit
    servers:
      ledger:
        operations:
          record: { resource: { kind: ledger_line, from: line } }
`;

const project = (extra = "", files: Record<string, string> = KIT) =>
  resolveProject({
    host: memoryHost({
      "nodrail.yaml": `kind: nodrail.project/v1\nruntimes: [claude-code, codex]\nresources: ./r.yaml\n${PLUGINS}${extra}`,
      "r.yaml": resources,
      ...files,
    }),
    catalog: [],
  });
const messages = (result: ReturnType<typeof project>) =>
  result.problems.map((problem) => problem.message);

describe("declaring a plugin", () => {
  test("reads its folder, the hosts it has a manifest for, and its version", () => {
    const result = project();
    expect(messages(result)).toEqual([]);
    expect(result.setup.plugins).toEqual([
      {
        name: "desk-kit",
        spec: expect.objectContaining({ source: "./vendor/desk-kit" }),
        folder: "vendor/desk-kit",
        hosts: ["claude-code", "codex"],
        versions: { "claude-code": "0.1.0", codex: "0.1.0" },
      },
    ]);
  });

  test.each([
    [
      "a missing folder",
      {
        ...KIT,
        "vendor/desk-kit/.claude-plugin/plugin.json": undefined,
        "vendor/desk-kit/.mcp.json": undefined,
        "vendor/desk-kit/.codex-plugin/plugin.json": undefined,
        "vendor/desk-kit/.codex.mcp.json": undefined,
        "vendor/desk-kit/skills/desk-greeting/SKILL.md": undefined,
      },
      "No such folder",
    ],
    [
      "no Codex manifest",
      { ...KIT, "vendor/desk-kit/.codex-plugin/plugin.json": undefined },
      "No .codex-plugin/plugin.json in vendor/desk-kit, and the setup is for codex",
    ],
    [
      "another name",
      {
        ...KIT,
        "vendor/desk-kit/.claude-plugin/plugin.json": '{"name":"kit"}',
      },
      ".claude-plugin/plugin.json names it kit, not desk-kit",
    ],
    [
      "a server it doesn't bring",
      { ...KIT, "vendor/desk-kit/.codex.mcp.json": '{"mcpServers":{}}' },
      "Its codex manifest brings no MCP server ledger",
    ],
  ])("refuses %s", (_, files, message) => {
    const clean = Object.fromEntries(
      Object.entries(files).filter(([, text]) => text !== undefined),
    ) as Record<string, string>;
    expect(messages(project("", clean))).toContainEqual(message);
  });

  test("a server named like a connection or another plugin's is refused", () => {
    const clash = project(`connections:
  ledger:
    command: node
    operations: { record: {} }
`);
    expect(messages(clash)).toContainEqual(
      "desk-kit's server ledger has the name of connection ledger: Codex couldn't tell their calls apart",
    );
  });

  test("agentPlugins names team members and declared plugins", () => {
    expect(
      messages(
        project("agentPlugins:\n  nobody: [desk-kit]\n  support: [other]\n"),
      ),
    ).toEqual([
      "nobody isn't on the team",
      "support uses other, which isn't a plugin",
    ]);
  });
});

describe("reading a plugin's calls", () => {
  const calls = pluginCalls({
    "desk-kit": {
      source: "./vendor/desk-kit",
      servers: {
        ledger: {
          operations: {
            record: { resource: { kind: "ledger_line", from: "line" } },
          },
        },
      },
    },
  } as Plugins);
  const read = (name: string, host?: "claude-code" | "codex") =>
    connectionCall(name, { line: "hi" }, calls, host);

  test("as Claude Code names them, by plugin and server", () => {
    expect(read("mcp__plugin_desk-kit_ledger__record")).toMatchObject({
      tool: "ledger",
      operation: "record",
      resource: { kind: "ledger_line", id: "hi" },
    });
    expect(read("mcp__plugin_desk-kit_ledger__erase")).toBe(
      "erase isn't an operation connection ledger declares",
    );
  });

  test("as Codex names them, by server alone, and only on Codex", () => {
    expect(read("mcp__ledger__record", "codex")).toMatchObject({
      tool: "ledger",
    });
    // On Claude Code a bare name is another server that shares the name.
    expect(read("mcp__ledger__record", "claude-code")).toBeNull();
  });

  test("another plugin's server of the same name isn't read as it", () => {
    expect(read("mcp__plugin_other_ledger__record")).toBeNull();
  });
});

describe("a team's plugins", () => {
  const decide = (
    extra: string,
    agent: string,
    tool: string,
    input: Record<string, unknown>,
  ) => {
    const result = project(`${extra}`);
    expect(messages(result)).toEqual([]);
    const compiled = compilePolicies([
      ...result.sources,
      {
        name: "open.yaml",
        text: "- rule: Anything on the ledger\n  tool: ledger\n  operation: record\n  resource: { kind: ledger_line, match: any }\n  effect: allow\n",
      },
    ]);
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.issues));
    const action =
      connectionCall(
        tool,
        input,
        pluginCalls(
          result.setup.plugins.reduce(
            (all, p) => ({ ...all, [p.name]: p.spec }),
            {} as Plugins,
          ),
        ),
        "claude-code",
      ) ?? describeToolCall(tool, input);
    if (!action || typeof action === "string") throw new Error(String(action));
    return simulate({
      document: compiled.document,
      descriptor: toDescriptor(action, { agent }),
      now: new Date("2026-11-19T00:00:00Z"),
    }).outcome;
  };
  const record = "mcp__plugin_desk-kit_ledger__record";
  const skill = { skill: "desk-kit:desk-greeting" };

  test("without agentPlugins, every member may use it and load its skills", () => {
    expect(decide("", "marketing", record, { line: "x" })).toBe("allow");
    expect(decide("", "support", "Skill", skill)).toBe("allow");
    expect(
      decide("", "support", "Skill", { skill: "other:desk-greeting" }),
    ).toBe("none");
  });

  test("with it, a member not given the plugin is denied its operations and skills", () => {
    const only = "agentPlugins:\n  support: [desk-kit]\n";
    expect(decide(only, "support", record, { line: "x" })).toBe("allow");
    expect(decide(only, "support", "Skill", skill)).toBe("allow");
    expect(decide(only, "marketing", record, { line: "x" })).toBe("deny");
    expect(decide(only, "marketing", "Skill", skill)).toBe("none");
  });
});
