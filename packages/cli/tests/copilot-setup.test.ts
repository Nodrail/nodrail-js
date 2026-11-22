// GitHub Copilot CLI as a runtime (W5): plan and apply write its agents,
// skills, MCP servers and hook file; it runs the hook once the folder is
// trusted; status, observe and destroy know it like the other hosts.
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { COPILOT_HOOKS } from "../src/setup/copilot.ts";
import { fakeIo } from "./support/fake-io.ts";
import {
  copilotTools,
  filesUnder,
  locked,
  RESOURCES,
  windows,
} from "./support/setup-project.ts";

const json = (text: string) => JSON.parse(text) as Record<string, any>;

async function copilotProject() {
  const p = await locked(
    {
      ...RESOURCES,
      "nodrail.yaml": RESOURCES["nodrail.yaml"].replace(
        "runtime: claude-code",
        "runtime: copilot",
      ),
    },
    copilotTools(),
  );
  const home = join(p.home, "copilot-home");
  mkdirSync(home, { recursive: true });
  p.env.COPILOT_HOME = home;
  const trust = () =>
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ trustedFolders: [realpathSync(p.cwd)] }),
    );
  return { p, home, trust };
}

describe.skipIf(windows)("Copilot as a runtime", () => {
  test("apply writes the agents, skills and the hook file; starting is copilot --agent", async () => {
    const { p } = await copilotProject();
    const plan = await p.run("plan");
    expect(plan.out).toContain(`+ ${COPILOT_HOOKS}`);
    expect(plan.out).toContain("+ .github/agents/lead.agent.md");
    const applied = await p.run("apply", "--yes");
    expect(applied.code).toBe(0);
    expect(applied.out).toContain("Run `copilot --agent lead`");
    const hooks = json(p.read(COPILOT_HOOKS));
    expect(hooks.version).toBe(1);
    expect(hooks.hooks.preToolUse[0].bash).toMatch(
      /^nodrail policy hook '\/.+\/\.nodrail\/effective\.yaml' --protect-list '.+' --host copilot --agent lead$/,
    );
    expect(hooks.hooks.sessionStart[0].bash).toMatch(
      /^nodrail observe '\/.+' --detach$/,
    );
    expect(p.read(".github/agents/lead.agent.md")).toMatch(
      /^---\n# Written by nodrail apply[\s\S]*name: lead\n/,
    );
    expect(
      Object.keys(filesUnder(p.cwd)).some((file) =>
        file.startsWith(".github/skills/release-notes/"),
      ),
    ).toBe(true);
  });

  test("the hook runs once the folder is trusted: status says which", async () => {
    const { p, trust } = await copilotProject();
    await p.run("apply", "--yes");
    const untrusted = await p.run("status");
    expect(untrusted.code).toBe(1);
    expect(untrusted.out).toContain("Copilot: starts as lead");
    expect(untrusted.out).toContain(
      "Policy hook: inactive, Copilot runs the project's hooks only in a trusted folder",
    );
    trust();
    const trusted = await p.run("status");
    expect(trusted.code).toBe(0);
    expect(trusted.out).toContain("Policy hook: configured");
    expect(trusted.out).toContain("Observation: at each session start.");
  });

  test("disableAllHooks anywhere Copilot reads it blocks the plan", async () => {
    const { p } = await copilotProject();
    p.write(
      ".github/copilot/settings.json",
      JSON.stringify({ disableAllHooks: true }),
    );
    const plan = await p.run("plan");
    expect(plan.code).toBe(1);
    expect(plan.out).toContain(
      "sets disableAllHooks: Copilot would run no hook",
    );
  });

  test("status names what nodrail doesn't manage; destroy takes out what apply wrote", async () => {
    const { p, home, trust } = await copilotProject();
    await p.run("apply", "--yes");
    trust();
    p.write(".github/agents/mine.agent.md", "---\nname: mine\n---\n");
    p.write(
      ".github/hooks/other.json",
      JSON.stringify({ version: 1, hooks: { postToolUse: [] } }),
    );
    writeFileSync(
      join(home, "mcp-config.json"),
      JSON.stringify({ mcpServers: { notes: { command: "n" } } }),
    );
    const { out } = await p.run("status");
    expect(out).toContain("agent mine  (./.github/agents)");
    expect(out).toContain("hook postToolUse (other.json)  (.github/hooks)");
    expect(out).toContain("MCP server notes");
    expect(out).not.toContain("agent lead  (");
    expect((await p.run("destroy", "--yes")).code).toBe(0);
    expect(
      Object.keys(filesUnder(p.cwd)).some(
        (file) =>
          file === COPILOT_HOOKS || file.startsWith(".github/agents/lead"),
      ),
    ).toBe(false);
    expect(p.read(".github/agents/mine.agent.md")).toContain("mine");
  });
});

describe.skipIf(windows)("Copilot's places are protected", () => {
  test("the protect list names them; the hook refuses to change them", async () => {
    const { p } = await copilotProject();
    await p.run("apply", "--yes");
    const list = p.read(".nodrail/protected.txt");
    for (const place of [
      ".github/hooks",
      ".github/agents",
      ".github/copilot",
      ".github/mcp.json",
      ".github/skills",
    ])
      expect(list).toContain(`${place}\n`);
    expect(list).not.toMatch(/^\.github$/m);
    const hook = JSON.parse(p.read(COPILOT_HOOKS)).hooks.preToolUse[0]
      .bash as string;
    const policy = /hook '([^']+)'/.exec(hook)![1]!;
    const protect = /--protect-list '([^']+)'/.exec(hook)![1]!;
    const event = (path: string) =>
      JSON.stringify({
        cwd: p.cwd,
        toolName: "create",
        toolArgs: { path: join(p.cwd, path), file_text: "{}" },
      });
    for (const [path, refused] of [
      [".github/copilot/settings.json", true],
      [".github/hooks/nodrail.json", true],
      [".github/workflows/ci.yml", false],
    ] as const) {
      const t = fakeIo({ cwd: p.cwd, home: p.home, stdin: event(path) });
      await t.run(
        "policy",
        "hook",
        policy,
        "--protect-list",
        protect,
        "--host",
        "copilot",
      );
      const reason = (
        JSON.parse(t.stdout()) as { permissionDecisionReason: string }
      ).permissionDecisionReason;
      // Refused by the guard, or only by the rules (none covers it).
      expect(!reason.includes("no rule covers"), `${path}: ${reason}`).toBe(
        refused,
      );
    }
  });
});
