// What `plan` says beside its steps (W1.2): the revision intended and the
// one each host was applied from, whether the host runs the policy hook,
// what a change reaches on the other host, and a missing state.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { parse } from "yaml";
import { describe, expect, test } from "vitest";
import { applySetup } from "../src/setup/apply.ts";
import { codexHookCommand } from "../src/setup/codex.ts";
import { planSetup } from "../src/setup/plan.ts";
import { claudeActivation } from "../src/setup/status.ts";
import {
  codexTools,
  locked,
  RESOURCES,
  windows,
} from "./support/setup-project.ts";

type PlanJson = {
  ready: boolean;
  active: boolean | null;
  activation: { state: string; detail: string };
  revision: { policy: string | null; workspace: string | null };
  applied: Record<string, { policy?: string; workspace?: string } | null>;
  notes: string[];
};
const json = (out: string) => JSON.parse(out) as PlanJson;
const lockOf = (p: { read: (path: string) => string }) =>
  parse(p.read("nodrail.lock.yaml")) as {
    effective: { sha256: string };
    workspace: { sha256: string };
  };

describe("the revision", () => {
  test("plan names the one locked; apply records it for the host", async () => {
    const p = await locked();
    const lock = lockOf(p);
    const before = json((await p.run("plan", "--json")).out);
    expect(before.revision).toEqual({
      policy: lock.effective.sha256,
      workspace: lock.workspace.sha256,
    });
    expect(before.applied).toEqual({});
    expect((await p.run("plan")).out).toContain(
      `Revision: workspace ${lock.workspace.sha256.slice(0, 12)}, policy ${lock.effective.sha256.slice(0, 12)}`,
    );
    expect((await p.run("apply", "--yes")).code).toBe(0);
    const after = json((await p.run("plan", "--json")).out);
    expect(after.applied).toEqual({ "claude-code": before.revision });
  });
});

describe("Claude Code's activation", () => {
  test("inactive until applied, then configured; plan's exit is unchanged", async () => {
    const p = await locked();
    const before = await p.run("plan");
    expect(before.code).toBe(0);
    expect(before.out).toContain(
      "Policy hook: inactive, apply hasn't written the hook and the policy yet.",
    );
    const required = await p.run("plan", "--require-active");
    expect(required.code).toBe(1);
    expect(required.err).toContain(
      "The policy isn't enforced here yet (inactive)",
    );
    await p.run("apply", "--yes");
    const after = json((await p.run("plan", "--json")).out);
    expect(after.activation.state).toBe("configured");
    expect(after.active).toBeNull();
    expect((await p.run("plan", "--require-active")).code).toBe(0);
  });

  test("a settings file that turns hooks off makes it inactive", async () => {
    const p = await locked();
    await p.run("apply", "--yes");
    mkdirSync(join(p.home, ".claude"), { recursive: true });
    writeFileSync(
      join(p.home, ".claude/settings.json"),
      '{"disableAllHooks": true}',
    );
    const plan = json((await p.run("plan", "--json")).out);
    expect(plan.activation).toEqual({
      state: "inactive",
      detail: `${join(p.home, ".claude/settings.json")} sets disableAllHooks, so no hook runs`,
    });
    expect((await p.run("plan", "--require-active")).code).toBe(1);
  });

  test("so does an administrator's that allows only managed hooks", () => {
    const folder = mkdtempSync(join(tmpdir(), "nodrail-managed-"));
    const managed = folder;
    const file = join(folder, "managed-settings.json");
    writeFileSync(file, '{"allowManagedHooksOnly": true}');
    const home = mkdtempSync(join(tmpdir(), "nodrail-home-"));
    expect(
      claudeActivation({ root: folder, home, env: {}, managed }).state,
    ).toBe("inactive");
    writeFileSync(file, "{}");
    expect(
      claudeActivation({ root: folder, home, env: {}, managed }).state,
    ).toBe("configured");
    // A drop-in file counts too, as does keeping hooks to plugins.
    mkdirSync(join(folder, "managed-settings.d"));
    writeFileSync(
      join(folder, "managed-settings.d/10-lock.json"),
      '{"strictPluginOnlyCustomization": ["hooks"]}',
    );
    expect(
      claudeActivation({ root: folder, home, env: {}, managed }).detail,
    ).toContain("keep hooks to plugins");
    writeFileSync(join(folder, "managed-settings.d/10-lock.json"), "{}");
    // Claude Code reads its folder from CLAUDE_CONFIG_DIR when set.
    const config = mkdtempSync(join(tmpdir(), "nodrail-config-"));
    writeFileSync(join(config, "settings.json"), '{"disableAllHooks": true}');
    expect(
      claudeActivation({
        root: folder,
        home,
        env: { CLAUDE_CONFIG_DIR: config },
        managed,
      }).state,
    ).toBe("inactive");
  });
});

describe("a source changed after the plan was shown", () => {
  test("stops apply before it writes", async () => {
    const p = await locked();
    const place = { root: p.cwd, home: p.home, env: p.env };
    const reviewed = planSetup(place);
    p.write("skills/release-notes/template.md", "## Changed while you read\n");
    expect(() => applySetup(place, reviewed, "`nodrail apply`")).toThrow(
      "The project changed after the plan was shown. Nothing was changed",
    );
    expect(() => p.read(".nodrail/setup-state.json")).toThrow();
  });
});

describe("a missing state", () => {
  test("is named, and nothing is taken over", async () => {
    const p = await locked();
    await p.run("apply", "--yes");
    rmSync(join(p.cwd, ".nodrail/setup-state.json"));
    writeFileSync(join(p.cwd, ".nodrail/effective.apf.yaml"), "# edited\n");
    const plan = await p.run("plan", "--json");
    expect(json(plan.out).notes).toContainEqual(
      expect.stringContaining(
        ".nodrail/setup-state.json is missing, so nodrail owns none of the files marked !",
      ),
    );
    expect(plan.code).toBe(1);
  });
});

describe.skipIf(windows)("both hosts in one folder", () => {
  const BOTH = {
    ...RESOURCES,
    "nodrail.yaml": RESOURCES["nodrail.yaml"].replace(
      "runtime: claude-code",
      "runtimes: [claude-code, codex]",
    ),
  };

  async function both(trusted: boolean) {
    const bin = codexTools();
    const p = await locked(BOTH, bin);
    const hooks = trusted
      ? [
          {
            source: "project",
            eventName: "preToolUse",
            command: codexHookCommand(p.cwd, "lead"),
            trustStatus: "trusted",
          },
        ]
      : [];
    writeFileSync(join(bin, "hooks.json"), JSON.stringify(hooks));
    const parent = dirname(p.cwd);
    const as = (host: string, ...rest: string[]) =>
      p.runFrom(
        parent,
        rest[0]!,
        `./${basename(p.cwd)}`,
        "--runtime",
        host,
        ...rest.slice(1),
      );
    return { ...p, as };
  }

  test("a policy change names the other host and when it takes effect there", async () => {
    const p = await both(true);
    expect((await p.as("claude-code", "apply", "--yes")).code).toBe(0);
    expect((await p.as("codex", "apply", "--yes")).code).toBe(0);
    p.write(
      "policies/base.yaml",
      `${RESOURCES["policies/base.yaml"]}- rule: Search anything\n  tool: files\n  operation: file.search\n  resource: { kind: file, match: any }\n  effect: allow\n`,
    );
    await p.run("policy", "lock");
    const plan = await p.as("claude-code", "plan");
    expect(plan.out).toContain(
      "Codex is set up here too and reads the same policy: it enforces the new one from its next tool call, in sessions already open.",
    );
    expect(plan.out).toMatch(
      /Codex's agents and skills are from workspace [0-9a-f]{12}: run `nodrail apply --runtime codex` to bring them to [0-9a-f]{12}\./,
    );
    expect((await p.as("claude-code", "apply", "--yes")).code).toBe(0);
    expect((await p.as("codex", "apply", "--yes")).code).toBe(0);
    expect((await p.as("claude-code", "plan")).out).not.toContain(
      "Codex's agents",
    );
  });

  test("Codex is verified when it says so, and inactive until trusted", async () => {
    const p = await both(false);
    await p.as("codex", "apply", "--yes");
    const untrusted = json((await p.as("codex", "plan", "--json")).out);
    expect(untrusted.activation.state).toBe("inactive");
    expect(untrusted.active).toBe(false);
    expect((await p.as("codex", "plan", "--require-active")).code).toBe(1);
    const trusted = await both(true);
    await trusted.as("codex", "apply", "--yes");
    const plan = json((await trusted.as("codex", "plan", "--json")).out);
    expect(plan.activation).toEqual({
      state: "verified",
      detail: "Codex runs nodrail's hook here",
    });
    expect(plan.active).toBe(true);
    expect((await trusted.as("codex", "plan", "--require-active")).code).toBe(
      0,
    );
  });
});
