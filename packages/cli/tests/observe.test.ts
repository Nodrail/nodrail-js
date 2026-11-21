// Observation (W3.2): apply adds a session-start hook on each host that runs
// `nodrail observe`, which records the project's latest status in the home
// folder: counts by default, names only when the project opts in. It never
// changes the project and never stops a session.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { spoolFolder } from "@nodrail/policy-engine/command-line";
import { TELEMETRY_FILE } from "../src/setup/connections.ts";
import { lastObservation, observationFile } from "../src/setup/observe.ts";
import { fakeIo } from "./support/fake-io.ts";
import {
  codexTools,
  filesUnder,
  locked,
  recordSenderStatus,
  RESOURCES,
  windows,
} from "./support/setup-project.ts";

const SECRET = "marker-observe-not-recorded";

/** An agent and an MCP server nodrail doesn't manage, the server with a secret. */
function addUnmanaged(p: { write: (path: string, text: string) => void }) {
  p.write(".claude/agents/mine.md", "---\nname: mine\n---\n");
  const server = { command: "x", env: { T: SECRET } };
  p.write(".mcp.json", JSON.stringify({ mcpServers: { github: server } }));
}

const json = (text: string) => JSON.parse(text) as Record<string, any>;

describe.skipIf(windows)("the run hooks", () => {
  const gated = {
    ...RESOURCES,
    "policies/base.yaml": `${RESOURCES["policies/base.yaml"]}- gate: Publish after the lead passes it
  id: led
  agent: publisher
  tool: files
  operation: file.write
  resource: { kind: file, match: any }
  requires:
    - { agent: lead, verdict: pass }
  otherwise: deny
`,
  };

  test("Claude Code: with gates, SubagentStart and SubagentStop run the policy hook; destroy takes them out", async () => {
    const p = await locked(gated);
    await p.run("apply", "--yes");
    const hooks = json(p.read(".claude/settings.json")).hooks;
    const policy = hooks.PreToolUse[0].hooks[0].command;
    for (const event of ["SubagentStart", "SubagentStop"])
      expect(hooks[event]).toEqual([
        { hooks: [{ type: "command", command: policy }] },
      ]);
    expect((await p.run("destroy", "--yes")).code).toBe(0);
    expect(existsSync(join(p.cwd, ".claude/settings.json"))).toBe(false);
  });

  test("Claude Code: without gates or budgets, no step hooks", async () => {
    const p = await locked();
    await p.run("apply", "--yes");
    const hooks = json(p.read(".claude/settings.json")).hooks;
    expect(hooks.SubagentStart).toBeUndefined();
    expect(hooks.SubagentStop).toBeUndefined();
  });
});

describe.skipIf(windows)("the session-start hook", () => {
  test("Claude Code: in settings by default; out with sessionStart: false, and on destroy", async () => {
    const p = await locked();
    await p.run("apply", "--yes");
    expect(json(p.read(".claude/settings.json")).hooks.SessionStart).toEqual([
      {
        hooks: [
          {
            type: "command",
            command: 'nodrail observe "$CLAUDE_PROJECT_DIR" --detach',
          },
        ],
      },
    ]);
    p.write(
      "nodrail.yaml",
      `${RESOURCES["nodrail.yaml"]}observe: { sessionStart: false }\n`,
    );
    await p.run("policy", "lock");
    await p.run("apply", "--yes");
    expect(
      json(p.read(".claude/settings.json")).hooks.SessionStart,
    ).toBeUndefined();
    p.write(
      "nodrail.yaml",
      `${RESOURCES["nodrail.yaml"]}observe: { names: true }\n`,
    );
    await p.run("policy", "lock");
    await p.run("apply", "--yes");
    expect(
      json(p.read(".claude/settings.json")).hooks.SessionStart[0].hooks[0]
        .command,
    ).toBe('nodrail observe "$CLAUDE_PROJECT_DIR" --detach --names');
    // The person's own session-start hook stays through apply and destroy.
    const settings = json(p.read(".claude/settings.json"));
    settings.hooks.SessionStart.push({
      hooks: [{ type: "command", command: "echo hi" }],
    });
    p.write(".claude/settings.json", JSON.stringify(settings));
    await p.run("destroy", "--yes");
    expect(json(p.read(".claude/settings.json")).hooks).toEqual({
      SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }],
    });
  });

  test("Codex: in hooks.json, by the project's full path", async () => {
    const p = await locked(
      {
        ...RESOURCES,
        "nodrail.yaml": RESOURCES["nodrail.yaml"].replace(
          "runtime: claude-code",
          "runtime: codex",
        ),
      },
      codexTools(),
    );
    await p.run("apply", "--yes");
    const hooks = json(p.read(".codex/hooks.json")).hooks;
    expect(hooks.SessionStart[0].hooks[0].command).toMatch(
      /^nodrail observe '\/.+' --detach$/,
    );
    expect(hooks.PreToolUse[0].hooks[0].command).toContain(
      "nodrail policy hook",
    );
  });
});

describe.skipIf(windows)("nodrail observe", () => {
  test("records counts, not names, in the home folder; the project is untouched", async () => {
    const p = await locked();
    await p.run("apply", "--yes");
    addUnmanaged(p);
    const before = filesUnder(p.cwd);
    expect(await p.run("observe", p.cwd)).toMatchObject({
      code: 0,
      out: "",
      err: "",
    });
    expect(filesUnder(p.cwd)).toEqual(before);
    const record = lastObservation(p.home, p.cwd)!;
    expect(record).toMatchObject({
      observation: 1,
      inStep: true,
      hosts: [
        {
          host: "claude-code",
          entry: "lead",
          activation: "configured",
          drift: 0,
          unmanaged: { agent: 1, "MCP server": 1 },
        },
      ],
    });
    expect(record.hosts[0]!.names).toBeUndefined();
    const text = readFileSync(observationFile(p.home, p.cwd), "utf8");
    expect(text).not.toContain("github");
    expect(text).not.toContain(SECRET);

    await p.run("observe", p.cwd, "--names");
    expect(lastObservation(p.home, p.cwd)!.hosts[0]!.names!.unmanaged).toEqual([
      "agent mine (project)",
      "MCP server github (project)",
    ]);
    expect(readFileSync(observationFile(p.home, p.cwd), "utf8")).not.toContain(
      SECRET,
    );
  });

  test("status shows when it was last recorded, and a stale one", async () => {
    const p = await locked();
    await p.run("apply", "--yes");
    expect((await p.run("status")).out).toContain("Last recorded: never");
    await p.run("observe", p.cwd);
    const status = await p.run("status");
    expect(status.out).toContain("Observation: at each session start.");
    expect(status.out).toMatch(
      /Last recorded: \S+ \(less than an hour ago\); in step then\./,
    );
    const file = observationFile(p.home, p.cwd);
    const old = {
      ...json(readFileSync(file, "utf8")),
      at: new Date(Date.now() - 30 * 3_600_000).toISOString(),
    };
    writeFileSync(file, JSON.stringify(old));
    expect((await p.run("status")).out).toContain(
      "(30 h ago), stale: no session here in 24 h",
    );
  });

  test("not set up, or anything wrong: records nothing, exits 0", async () => {
    const p = await locked();
    expect((await p.run("observe", p.cwd)).code).toBe(0);
    expect(lastObservation(p.home, p.cwd)).toBeNull();
    p.write(".nodrail/setup-state.json", "not json");
    expect((await p.run("observe", p.cwd)).code).toBe(0);
  });

  test("--detach starts it apart and returns at once", async () => {
    const marker = join(mkdtempSync(join(tmpdir(), "nodrail-detach-")), "ran");
    const script = join(marker, "..", "child.cjs");
    writeFileSync(
      script,
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, process.argv.slice(2).join(" "));`,
    );
    const io = fakeIo({ self: [script] });
    expect(
      await io.run("observe", "/some/project", "--detach", "--names"),
    ).toBe(0);
    for (let i = 0; i < 100 && !existsSync(marker); i++)
      await new Promise((done) => setTimeout(done, 50));
    expect(readFileSync(marker, "utf8")).toBe("observe /some/project --names");
  });
});

describe.skipIf(windows)("sending the observation (W3.3)", () => {
  const TELEMETRY =
    "telemetry:\n  traces:\n    endpoint: http://127.0.0.1:9/v1/traces\n";

  /** The spans waiting in the project's telemetry queue; the sender held back. */
  function queued(p: { cwd: string; home: string }) {
    const folder = spoolFolder(p.home, join(p.cwd, TELEMETRY_FILE));
    try {
      return readFileSync(join(folder, "spool.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as {
              traceId: string;
              name: string;
              attributes: Record<string, string>;
            },
        );
    } catch {
      return [];
    }
  }

  /** The sender waits out a failure, so the queue stays as observe left it. */
  const holdSender = (p: { cwd: string; home: string }) =>
    recordSenderStatus(p, {
      state: "degraded",
      retryAfter: Date.now() + 600_000,
    });

  test("no telemetry: nothing queued", async () => {
    const p = await locked();
    await p.run("apply", "--yes");
    await p.run("observe", p.cwd);
    expect(queued(p)).toEqual([]);
  });

  test("with telemetry: one span per host, counts only, never the path; names when asked", async () => {
    const p = await locked({
      ...RESOURCES,
      "nodrail.yaml": `${RESOURCES["nodrail.yaml"]}${TELEMETRY}`,
    });
    await p.run("apply", "--yes");
    holdSender(p);
    addUnmanaged(p);
    await p.run("observe", p.cwd);
    const [span, ...rest] = queued(p);
    expect(rest).toEqual([]);
    expect(span!.name).toBe("nodrail.observation");
    expect(span!.attributes).toMatchObject({
      "nodrail.host": "claude-code",
      "nodrail.agent": "lead",
      "nodrail.activation": "configured",
      "nodrail.in_step": "true",
      "nodrail.drift": "0",
      "nodrail.unmanaged.agent": "1",
      "nodrail.unmanaged.mcp_server": "1",
    });
    expect(span!.attributes["nodrail.workspace.revision"]).toMatch(
      /^[0-9a-f]{64}$/,
    );
    // The machine: a random id made once, the same next time.
    const machine = readFileSync(
      join(p.home, ".nodrail/machine-id"),
      "utf8",
    ).trim();
    expect(span!.attributes["nodrail.machine"]).toBe(machine);
    expect(machine).toMatch(/^[0-9a-f]{32}$/);
    expect(span!.attributes["nodrail.unmanaged.names"]).toBeUndefined();
    const text = JSON.stringify(queued(p));
    for (const hidden of [p.cwd, p.home, "github", SECRET])
      expect(text).not.toContain(hidden);

    await p.run("observe", p.cwd, "--names");
    const named = queued(p)[1]!;
    expect(named.attributes["nodrail.machine"]).toBe(
      span!.attributes["nodrail.machine"],
    );
    expect(JSON.parse(named.attributes["nodrail.unmanaged.names"]!)).toEqual([
      "agent mine (project)",
      "MCP server github (project)",
    ]);
    expect(JSON.stringify(queued(p))).not.toContain(SECRET);
  });

  test("Codex and Claude Code in one observation share a trace", async () => {
    const yaml = RESOURCES["nodrail.yaml"].replace(
      "runtime: claude-code",
      "runtimes: [claude-code, codex]",
    );
    const p = await locked(
      { ...RESOURCES, "nodrail.yaml": `${yaml}${TELEMETRY}` },
      codexTools(),
    );
    await p.run("apply", "--yes", "--runtime", "codex");
    await p.run("apply", "--yes", "--runtime", "claude-code");
    holdSender(p);
    await p.run("observe", p.cwd);
    const spans = queued(p);
    expect(spans.map((span) => span.attributes["nodrail.host"]).sort()).toEqual(
      ["claude-code", "codex"],
    );
    expect(new Set(spans.map((span) => span.traceId)).size).toBe(1);
  });
});
