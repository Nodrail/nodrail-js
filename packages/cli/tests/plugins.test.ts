// Plugins a setup ships with, set up on each host: the project becomes a
// marketplace that lists them from their folders, each host's settings
// switch them on, their files are locked and kept from agents, and the hook
// reads their servers' calls. Codex's install is the person's: plan names it.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, test } from "vitest";
import {
  codexTools,
  locked,
  RESOURCES,
  windows,
} from "./support/setup-project.ts";

const KIT = {
  "vendor/desk-kit/.claude-plugin/plugin.json":
    '{"name":"desk-kit","version":"0.1.0"}',
  "vendor/desk-kit/.mcp.json":
    '{"mcpServers":{"ledger":{"command":"node","args":["${CLAUDE_PLUGIN_ROOT}/s.cjs"]}}}',
  // Codex's manifest at another version, as one plugin's two manifests may be.
  "vendor/desk-kit/.codex-plugin/plugin.json":
    '{"name":"desk-kit","version":"0.1.1","skills":"./skills/","mcpServers":"./.codex.mcp.json"}',
  "vendor/desk-kit/.codex.mcp.json":
    '{"mcpServers":{"ledger":{"command":"node","args":["./s.cjs"],"cwd":"."}}}',
  "vendor/desk-kit/s.cjs": "// the ledger server\n",
  "vendor/desk-kit/skills/desk-greeting/SKILL.md":
    "---\nname: desk-greeting\n---\nGreet.\n",
};

const PLUGINS = `plugins:
  desk-kit:
    source: ./vendor/desk-kit
    servers:
      ledger:
        operations:
          record: { resource: { kind: ledger_line, from: line } }
agentPlugins:
  lead: [desk-kit]
`;

const files = (runtime = "runtime: claude-code") => ({
  ...RESOURCES,
  ...KIT,
  "policies/base.yaml": `${RESOURCES["policies/base.yaml"]}- rule: Record in the ledger
  tool: ledger
  operation: record
  resource: { kind: ledger_line, match: any }
  effect: allow
`,
  "nodrail.yaml": `${RESOURCES["nodrail.yaml"].replace("runtime: claude-code", runtime)}${PLUGINS}`,
});

const json = (text: string) => JSON.parse(text) as Record<string, any>;

describe("plugins on Claude Code", () => {
  test("plan lists the marketplace and says the folder must be trusted", async () => {
    const p = await locked(files());
    const { code, out } = await p.run("plan");
    expect(code).toBe(0);
    expect(out).toMatch(
      /\+ \.claude-plugin\/marketplace\.json\s+the plugins desk-kit/,
    );
    expect(out).toContain(
      "Claude Code loads the plugins desk-kit from this folder once you trust it; nothing is installed.",
    );
  });

  test("apply switches it on next to the person's own, and locks and guards its files", async () => {
    const p = await locked(files());
    p.write(
      ".claude/settings.json",
      JSON.stringify({ enabledPlugins: { "mine@theirs": true } }),
    );
    expect((await p.run("apply", "--yes")).code).toBe(0);
    expect(json(p.read(".claude-plugin/marketplace.json"))).toEqual({
      name: "nodrail-release",
      owner: { name: "nodrail" },
      plugins: [{ name: "desk-kit", source: "./vendor/desk-kit" }],
    });
    const settings = json(p.read(".claude/settings.json"));
    expect(settings.enabledPlugins).toEqual({
      "mine@theirs": true,
      "desk-kit@nodrail-release": true,
    });
    expect(
      settings.extraKnownMarketplaces["nodrail-release"].source.source,
    ).toBe("directory");
    expect(p.read(".nodrail/protected.txt")).toContain("\nvendor/desk-kit\n");
    const lock = parse(p.read("nodrail.lock.yaml")) as {
      workspace: { files: { path: string }[] };
    };
    expect(lock.workspace.files.map((file) => file.path)).toContain(
      "vendor/desk-kit/s.cjs",
    );
    expect(json(p.read(".nodrail/connections.json")).plugins).toEqual({
      ledger: {
        operations: {
          record: { resource: { kind: "ledger_line", from: "line" } },
        },
        plugin: "desk-kit",
      },
    });
  });

  test("the hook reads its calls: allowed for an agent given the plugin, denied otherwise", async () => {
    const p = await locked(files());
    await p.run("apply", "--yes");
    const decide = async (agent: string, tool: string, input: object) => {
      const { fakeIo } = await import("./support/fake-io.ts");
      const terminal = fakeIo({
        cwd: p.cwd,
        home: p.home,
        env: p.env,
        stdin: JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: tool,
          tool_input: input,
        }),
      });
      await terminal.run(
        "policy",
        "hook",
        join(p.cwd, ".nodrail/effective.yaml"),
        "--connections",
        join(p.cwd, ".nodrail/connections.json"),
        "--agent",
        agent,
      );
      const text = terminal.stdout();
      return text === ""
        ? "allow"
        : (
            JSON.parse(text) as {
              hookSpecificOutput: { permissionDecision: string };
            }
          ).hookSpecificOutput.permissionDecision;
    };
    const record = "mcp__plugin_desk-kit_ledger__record";
    expect(await decide("lead", record, { line: "hi" })).toBe("allow");
    expect(await decide("publisher", record, { line: "hi" })).toBe("deny");
    expect(await decide("lead", record, {})).toBe("deny");
    expect(
      await decide("lead", "Skill", { skill: "desk-kit:desk-greeting" }),
    ).toBe("allow");
    // Another server sharing the name, called bare on Claude Code, isn't it.
    expect(await decide("lead", "mcp__ledger__record", { line: "hi" })).toBe(
      "deny",
    );
  });

  test("an edited plugin file stops apply until it is locked again", async () => {
    const p = await locked(files());
    p.write("vendor/desk-kit/s.cjs", "// changed\n");
    const plan = await p.run("plan");
    expect(plan.code).toBe(1);
    expect(plan.out).toContain("~ vendor/desk-kit/s.cjs");
  });

  test("taking the plugin out takes nodrail's entries out and keeps the person's", async () => {
    const p = await locked(files());
    p.write(
      ".claude/settings.json",
      JSON.stringify({ enabledPlugins: { "mine@theirs": true } }),
    );
    await p.run("apply", "--yes");
    p.write("nodrail.yaml", RESOURCES["nodrail.yaml"]);
    await p.run("policy", "lock");
    expect((await p.run("apply", "--yes")).code).toBe(0);
    const settings = json(p.read(".claude/settings.json"));
    expect(settings.enabledPlugins).toEqual({ "mine@theirs": true });
    expect(settings.extraKnownMarketplaces).toEqual({});
    expect(() => p.read(".claude-plugin/marketplace.json")).toThrow();
  });
});

describe.skipIf(windows)("plugins on Codex", () => {
  test("apply declares the marketplace; plan names the install, which is the person's", async () => {
    const bin = codexTools();
    const p = await locked(files("runtime: codex"), bin);
    const codexHome = join(p.home, "codex-home");
    p.env.CODEX_HOME = codexHome;
    const plan = await p.run("plan");
    expect(plan.out).toContain(
      "? plugin desk-kit: Codex loads it once you install it: after apply, trust the folder, then run `codex plugin add desk-kit@nodrail-release` there. Codex installs plugins for you, in every folder",
    );
    await p.run("apply", "--yes");
    const config = p.read(".codex/config.toml");
    expect(config).toContain('[marketplaces."nodrail-release"]');
    expect(config).toContain(
      '[plugins."desk-kit@nodrail-release"]\nenabled = true',
    );
    expect(
      json(p.read(".agents/plugins/marketplace.json")).plugins[0].source,
    ).toEqual({
      source: "local",
      path: "./vendor/desk-kit",
    });
    // As `codex plugin add` leaves it.
    mkdirSync(join(codexHome, "plugins/cache/nodrail-release/desk-kit/0.1.1"), {
      recursive: true,
    });
    writeFileSync(
      join(codexHome, "plugins/cache/nodrail-release/desk-kit/0.1.1/x"),
      "",
    );
    expect((await p.run("plan")).out).toContain(
      "✓ plugin desk-kit: installed in Codex at 0.1.1",
    );
  });
});
