// An administrator's settings can turn off what nodrail sets up, whatever
// the project asks. `plan` reads the files it can and says what wouldn't
// load, before apply.
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { claudeManaged, codexManagedChecks } from "../src/setup/managed.ts";
import { planSetup } from "../src/setup/plan.ts";
import { codexTools, locked, RESOURCES } from "./support/setup-project.ts";

const folder = (files: Record<string, string>) => {
  const at = mkdtempSync(join(tmpdir(), "nodrail-admin-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(at, path, ".."), { recursive: true });
    writeFileSync(join(at, path), text);
  }
  return at;
};

const CONNECTION = `connections:
  handbook:
    command: node
    args: [./h.cjs]
    operations: { search: {} }
`;

const KIT = {
  "vendor/kit/.claude-plugin/plugin.json": '{"name":"kit"}',
  "vendor/kit/skills/s/SKILL.md": "---\nname: s\n---\n",
};

const desk = (extra = "") =>
  locked({
    ...RESOURCES,
    ...KIT,
    "h.cjs": "//\n",
    "nodrail.yaml": `${RESOURCES["nodrail.yaml"]}${CONNECTION}plugins:\n  kit:\n    source: ./vendor/kit\n${extra}`,
  });

describe("reading an administrator's Claude Code settings", () => {
  test("the file and its drop-ins merge: values replace, lists join", () => {
    const at = folder({
      "managed-settings.json":
        '{"deniedMcpServers":[{"serverName":"a"}],"agent":"x"}',
      "managed-settings.d/20-b.json":
        '{"deniedMcpServers":[{"serverName":"b"}],"agent":"y"}',
      "managed-settings.d/.hidden.json": '{"agent":"z"}',
      "managed-settings.d/notes.txt": "x",
    });
    expect(claudeManaged(at)).toEqual({
      deniedMcpServers: [{ serverName: "a" }, { serverName: "b" }],
      agent: "y",
    });
    expect(claudeManaged(folder({}))).toBeNull();
  });
});

describe("plan with an administrator's settings", () => {
  const checks = async (managed: Record<string, string>, extra?: string) => {
    const p = await desk(extra);
    const plan = planSetup({
      root: p.cwd,
      home: p.home,
      env: p.env,
      managed: { claude: folder(managed), profile: "/nonexistent" },
    });
    return {
      p,
      plan,
      failed: plan.checks
        .filter((check) => !check.ok)
        .map((check) => `${check.name}: ${check.detail}`),
    };
  };

  test("none: nothing more to say", async () => {
    expect((await checks({})).failed).toEqual([]);
  });

  test("a denied or unlisted connection is named, and blocks", async () => {
    const denied = await checks({
      "managed-settings.json":
        '{"deniedMcpServers":[{"serverName":"handbook"}]}',
    });
    expect(denied.failed).toEqual([
      "connection handbook: managed deniedMcpServers names it, so Claude Code won't load it. Ask your administrator, or take it out of nodrail.yaml",
    ]);
    const listed = await checks({
      "managed-settings.json":
        '{"allowedMcpServers":[{"serverName":"github"}]}',
    });
    expect(listed.failed[0]).toContain(
      "managed allowedMcpServers doesn't name it",
    );
    // Named by its exact command line, it's allowed.
    const p = await desk();
    const command = [
      "nodrail",
      "connection",
      "run",
      join(realpathSync(p.cwd), ".nodrail/connections.json"),
      "handbook",
    ];
    const byCommand = planSetup({
      root: p.cwd,
      home: p.home,
      env: p.env,
      managed: {
        claude: folder({
          "managed-settings.json": JSON.stringify({
            allowedMcpServers: [{ serverCommand: command }],
          }),
        }),
        profile: "/nonexistent",
      },
    });
    expect(byCommand.checks.filter((check) => !check.ok)).toEqual([]);
    expect(
      (await checks({ "managed-mcp.json": '{"mcpServers":{}}' })).failed[0],
    ).toContain("gives your administrator sole control of MCP servers");
  });

  test("a marketplace allowlist without this folder blocks the plugins", async () => {
    const strict = await checks({
      "managed-settings.json":
        '{"strictKnownMarketplaces":[{"source":"github","repo":"acme/plugins"}]}',
    });
    expect(strict.failed).toEqual([
      "marketplace nodrail-release: managed strictKnownMarketplaces doesn't allow a marketplace in this folder, so Claude Code won't load it. Ask your administrator, or take it out of nodrail.yaml",
    ]);
    const pattern = await checks({
      "managed-settings.json":
        '{"strictKnownMarketplaces":[{"source":"pathPattern","pathPattern":"nodrail-project-"}]}',
    });
    expect(pattern.failed).toEqual([]);
    const off = await checks({
      "managed-settings.json":
        '{"enabledPlugins":{"kit@nodrail-release":false}}',
    });
    expect(off.failed[0]).toContain(
      "plugin kit@nodrail-release: managed enabledPlugins turns it off",
    );
  });

  test("agents kept to plugins, or another agent forced, are named", async () => {
    const { failed } = await checks({
      "managed-settings.json":
        '{"strictPluginOnlyCustomization":["agents","skills"],"agent":"reviewer"}',
    });
    expect(failed).toEqual([
      expect.stringContaining(
        "project agents: managed strictPluginOnlyCustomization keeps agents to plugins",
      ),
      expect.stringContaining(
        "project skills: managed strictPluginOnlyCustomization keeps skills to plugins",
      ),
      expect.stringContaining(
        "agent: managed settings start every session as reviewer, not lead",
      ),
    ]);
  });

  test("a configuration profile it can't read is marked ?", async () => {
    const p = await desk();
    const profile = join(folder({ "x.plist": "x" }), "x.plist");
    const plan = planSetup({
      root: p.cwd,
      home: p.home,
      env: p.env,
      managed: { claude: folder({}), profile },
    });
    expect(plan.checks).toContainEqual(
      expect.objectContaining({
        name: "managed settings",
        ok: true,
        unverified: true,
      }),
    );
  });
});

describe("Codex requirements", () => {
  const setup = {
    connections: [
      {
        name: "handbook",
        spec: { command: "x", args: [], env: {}, operations: { a: {} } },
        files: [],
      },
    ],
    plugins: [
      {
        name: "kit",
        spec: { source: "./k", servers: {} },
        folder: "k",
        hosts: ["codex" as const],
        versions: {},
      },
    ],
  };
  const read = (text: string) =>
    codexManagedChecks({
      setup,
      folder: folder({ "requirements.toml": text }),
      profile: "/nonexistent",
    });

  test("what they may turn off is marked ?, never blocking", () => {
    const checks = read(`allowed_sandbox_modes = ["read-only"]

[mcp_servers.docs]
identity = { command = "codex-mcp" }

[features]
plugins = false

[marketplaces]
restrict_to_allowed_sources = true
`);
    expect(
      checks.map((check) => [check.name, check.ok, check.unverified]),
    ).toEqual([
      ["connection handbook", true, true],
      ["plugins", true, true],
      ["plugins", true, true],
    ]);
    expect(checks[0]!.detail).toContain(
      "lists MCP servers and not this one; Codex may not load it",
    );
  });

  test("a server it lists, or none at all, is fine", () => {
    expect(
      read('[mcp_servers.handbook]\nidentity = { command = "nodrail" }\n'),
    ).toEqual([]);
    expect(read('allowed_sandbox_modes = ["read-only"]\n')).toEqual([]);
  });

  test("plan shows them for Codex", async () => {
    const p = await locked(
      {
        ...RESOURCES,
        "h.cjs": "//\n",
        "nodrail.yaml": `${RESOURCES["nodrail.yaml"].replace("runtime: claude-code", "runtime: codex")}${CONNECTION}`,
      },
      codexTools(),
    );
    const plan = planSetup({
      root: p.cwd,
      home: p.home,
      env: p.env,
      managed: {
        codex: folder({ "requirements.toml": "[mcp_servers.docs]\n" }),
        profile: "/nonexistent",
      },
    });
    expect(plan.checks).toContainEqual(
      expect.objectContaining({
        name: "connection handbook",
        unverified: true,
      }),
    );
  });
});
