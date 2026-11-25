// `nodrail status`: each host as apply set it up, next to what is there
// now: drift since apply, the revision it came from, whether the hook runs,
// and what the host loads that nodrail doesn't manage. It reads only.
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { appliedCodexHook } from "../src/setup/inventory.ts";
import {
  codexTools,
  filesUnder,
  locked,
  RESOURCES,
  windows,
} from "./support/setup-project.ts";

const SECRET = "marker-status-not-for-output";

describe("nodrail status", () => {
  test("nothing set up: says so, exit 1", async () => {
    const p = await locked();
    const { code, err } = await p.run("status");
    expect(code).toBe(1);
    expect(err).toContain("Nothing here is set up by nodrail apply.");
  });

  test("as applied: in step, exit 0, and it changes nothing", async () => {
    const p = await locked();
    await p.run("apply", "--yes");
    const before = filesUnder(p.cwd);
    const { code, out } = await p.run("status");
    expect(code).toBe(0);
    expect(out).toContain("Claude Code: starts as lead");
    expect(out).toMatch(/Revision: workspace [0-9a-f]{12}, as locked/);
    expect(out).toContain("Hook configured:");
    expect(out).toContain("Since apply: nothing changed.");
    expect(filesUnder(p.cwd)).toEqual(before);
    const json = JSON.parse((await p.run("status", "--json")).out) as {
      inStep: boolean;
      hosts: { host: string }[];
    };
    expect(json.inStep).toBe(true);
    expect(json.hosts.map((host) => host.host)).toEqual(["claude-code"]);
  });

  test("drift since apply: edited, missing, and nodrail's settings changed", async () => {
    const p = await locked();
    await p.run("apply", "--yes");
    p.write(".claude/agents/lead.md", "Mine now.\n");
    rmSync(join(p.cwd, ".claude/skills/release-notes/template.md"));
    p.write(".claude/settings.json", JSON.stringify({ agent: "other" }));
    const { code, out } = await p.run("status");
    expect(code).toBe(1);
    expect(out).toMatch(
      /~ \.claude\/agents\/lead\.md\s+changed since apply wrote it/,
    );
    expect(out).toMatch(
      /- \.claude\/skills\/release-notes\/template\.md\s+written by apply, now gone/,
    );
    expect(out).toContain(
      "! .claude/settings.json  nodrail's policy hook is gone",
    );
    expect(out).toContain("! .claude/settings.json  starts as other, not lead");
  });

  test("names what nodrail doesn't manage, here and for the user, and nothing more", async () => {
    const p = await locked();
    await p.run("apply", "--yes");
    const config = join(p.home, "claude-config");
    p.env.CLAUDE_CONFIG_DIR = config;
    p.write(".claude/agents/mine.md", "---\nname: mine\n---\n");
    p.write(".claude/skills/own/SKILL.md", "---\nname: own\n---\n");
    p.write(
      ".mcp.json",
      JSON.stringify({
        mcpServers: { github: { command: "gh-mcp", env: { TOKEN: SECRET } } },
      }),
    );
    const settings = JSON.parse(p.read(".claude/settings.json")) as Record<
      string,
      any
    >;
    settings.hooks.PostToolUse = [
      { matcher: "*", hooks: [{ type: "command", command: "say done" }] },
    ];
    settings.enabledPlugins = { "linter@acme": true, "off@acme": false };
    p.write(".claude/settings.json", JSON.stringify(settings));
    mkdirSync(join(config, "skills/everywhere"), { recursive: true });
    writeFileSync(
      join(config, "settings.json"),
      JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: "command", command: "notify" }] }] },
      }),
    );
    writeFileSync(
      join(config, ".claude.json"),
      JSON.stringify({
        mcpServers: { notes: { command: "n", env: { KEY: SECRET } } },
        projects: {
          [realpathSync(p.cwd)]: { mcpServers: { local: { command: "l" } } },
        },
      }),
    );
    const { out } = await p.run("status");
    expect(out).toContain(
      "Not set up by nodrail (the hook still decides their tool calls):",
    );
    for (const line of [
      "agent mine  (./.claude/agents)",
      "skill own  (./.claude/skills)",
      "MCP server github  (.mcp.json)",
      `MCP server local  (${config}/.claude.json (this folder))`,
      "hook PostToolUse: say done  (.claude/settings.json)",
      "plugin linter@acme  (.claude/settings.json)",
      `skill everywhere  (${config}/skills)`,
      `MCP server notes  (${config}/.claude.json)`,
      `hook Stop: notify  (${config}/settings.json)`,
    ])
      expect(out).toContain(line);
    expect(out).not.toContain("off@acme");
    expect(out).not.toContain("release-notes  (");
    expect(out).not.toContain(SECRET);
  });

  test("a lock that moved on: the revision says to apply, exit 1", async () => {
    const p = await locked();
    await p.run("apply", "--yes");
    p.write("resources/lead.md", "You lead the release, carefully.\n");
    await p.run("policy", "lock");
    const { code, out } = await p.run("status");
    expect(code).toBe(1);
    expect(out).toMatch(
      /applied from workspace [0-9a-f]{12}; the lock is at [0-9a-f]{12}: run `nodrail plan --runtime claude-code`, then `nodrail apply --runtime claude-code`/,
    );
  });

  test.skipIf(windows)(
    "Codex: asks Codex which hooks run, and names the others",
    async () => {
      const bin = codexTools();
      const p = await locked(
        {
          ...RESOURCES,
          "nodrail.yaml": RESOURCES["nodrail.yaml"].replace(
            "runtime: claude-code",
            "runtime: codex",
          ),
        },
        bin,
      );
      await p.run("apply", "--yes");
      const ours = appliedCodexHook(p.cwd)!;
      writeFileSync(
        join(bin, "hooks.json"),
        JSON.stringify([
          {
            source: "project",
            eventName: "preToolUse",
            command: ours,
            trustStatus: "trusted",
          },
          {
            source: "user",
            eventName: "stop",
            command: "afplay done.aiff",
            trustStatus: "trusted",
          },
        ]),
      );
      const codexHome = join(p.home, "codex-home");
      mkdirSync(codexHome);
      p.env.CODEX_HOME = codexHome;
      writeFileSync(
        join(codexHome, "config.toml"),
        `model = "x"\n\n[mcp_servers.docs]\ncommand = "d"\n\n[mcp_servers.old]\ncommand = "o"\nenabled = false\n\n[plugins."figma@curated"]\nenabled = true\n\n[plugins."off@curated"]\nenabled = false\n`,
      );
      const { code, out } = await p.run("status");
      expect(code).toBe(0);
      expect(out).toContain(`MCP server docs  (${codexHome}/config.toml)`);
      expect(out).toContain(`plugin figma@curated  (${codexHome}/config.toml)`);
      expect(out).not.toContain("MCP server old");
      expect(out).not.toContain("off@curated");
      expect(out).toContain("Codex: starts as lead");
      expect(out).toContain("Hook active: Codex runs nodrail's hook here.");
      expect(out).toContain("hook stop: afplay done.aiff  (user)");
      expect(out).not.toContain("preToolUse: nodrail");
    },
  );
});
