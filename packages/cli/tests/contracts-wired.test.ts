// Declared receipts wired end to end: nodrail.yaml's receipts travel in the
// effective policy as the `contracts` entry engine level 4 reads, both hosts
// record a run's steps, and the hook holds a gate until the receipt that
// ends the agent's final message is valid against its contract.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { afterEach, describe, expect, test, vi } from "vitest";
import { COPILOT_HOOKS } from "../src/setup/copilot.ts";
import {
  copilotTools,
  fileOf,
  hookDocument,
  locked,
  project,
  planFor,
  RESOURCES,
  windows,
} from "./support/setup-project.ts";

const api = "apiVersion: nodrail.com/v1alpha1";

const SHAPES = `shapes:
  result-base:
    properties:
      verdict: { values: [done, blocked], role: verdict }
      issue: { type: string, max: 100 }
  reviewer-result:
    extends: result-base
    properties:
      verdict: { values: [ship, fix-first], role: verdict }
      findings:
        role: findings
        report: true
        properties:
          blocker: { type: integer, min: 0 }
  brief-shape:
    properties:
      issue: { type: string, max: 20 }
  unused:
    properties:
      verdict: { values: [ok], role: verdict }
receipts:
  reviewer: { shape: reviewer-result }
  outsider: { shape: unused }
`;

const AGENTS = [
  `${api}
kind: Agent
metadata: { name: lead }
spec:
  instructions: ./lead.md
  brief: brief-shape`,
  `${api}\nkind: Agent\nmetadata: { name: publisher }\nspec: { receipt: reviewer }`,
  `${api}\nkind: Agent\nmetadata: { name: loner }`,
].join("\n---\n");

const POLICY = `- required_engine_version: 4
- rule: Read anything
  tool: files
  operation: file.read
  resource: { kind: file, match: any }
  effect: allow
- rule: Write notes
  tool: files
  operation: file.write
  resource: { kind: file, match: any }
  effect: allow
- gate: Write after a clean review
  tool: files
  operation: file.write
  resource: { kind: file, match: any }
  requires:
    - { agent: publisher, verdict: ship, where: { findings.blocker: 0 } }
  otherwise: deny
`;

const FILES = {
  ...RESOURCES,
  "resources/agents.yaml": AGENTS,
  "policies/base.yaml": POLICY,
  "nodrail.yaml": `${RESOURCES["nodrail.yaml"].replace(
    "runtime: claude-code",
    "runtimes: [claude-code, copilot]",
  )}${SHAPES}`,
};

const COPILOT_ONLY = {
  ...RESOURCES,
  "nodrail.yaml": RESOURCES["nodrail.yaml"].replace(
    "runtime: claude-code",
    "runtime: copilot",
  ),
};

describe("receipts in the effective policy", () => {
  test("the contracts entry carries each agent's receipt and brief, and only the shapes they need", async () => {
    const p = await locked(FILES);
    const text = fileOf(planFor(p, "claude-code"), ".nodrail/effective.yaml");
    expect(text).toContain("# ── nodrail.yaml (contracts)\n");
    const items = parse(text) as Record<string, unknown>[];
    expect(items[0]).toEqual({ required_engine_version: 4 });
    expect(items[1]).toEqual({
      contracts: {
        shapes: {
          "result-base": parse(SHAPES).shapes["result-base"],
          "reviewer-result": parse(SHAPES).shapes["reviewer-result"],
          "brief-shape": parse(SHAPES).shapes["brief-shape"],
        },
        receipts: { reviewer: { shape: "reviewer-result" } },
        agents: {
          lead: { brief: "brief-shape" },
          publisher: { receipt: "reviewer" },
        },
      },
    });
    // The hook reads a version 3 document: publisher's receipt, pinned by
    // the digest the lock records, and the gate's compiled where.
    const document = hookDocument(text);
    expect(document.version).toBe(3);
    const lock = parse(p.read("nodrail.lock.yaml"));
    expect(document.receipts.publisher.contract).toBe(
      lock.contracts.shapes["reviewer-result"].contract,
    );
    expect(document.gates[0].requires[0].where).toEqual([
      { path: ["findings", "blocker"], op: "eq", value: 0 },
    ]);
    // The frozen export is that same file.
    const frozen = await p.run("policy", "export", "--frozen");
    expect(`${frozen.out}\n`).toBe(text);
  });

  test("Claude Code and Copilot record a run's steps when receipts are declared", async () => {
    const p = await locked(FILES, copilotTools());
    expect(
      (await p.run("apply", "--yes", "--runtime", "claude-code")).code,
    ).toBe(0);
    const hooks = JSON.parse(p.read(".claude/settings.json")).hooks;
    const command = hooks.PreToolUse[0].hooks[0].command;
    for (const event of ["SubagentStart", "SubagentStop"])
      expect(hooks[event]).toEqual([{ hooks: [{ type: "command", command }] }]);
    if (windows) return;
    const copilot = JSON.parse(fileOf(planFor(p, "copilot"), COPILOT_HOOKS));
    expect(copilot.hooks.subagentStart).toEqual(copilot.hooks.preToolUse);
    expect(copilot.hooks.subagentStop).toEqual(copilot.hooks.preToolUse);
  });

  test("Copilot gets no step hooks without gates, budgets or receipts", async () => {
    if (windows) return;
    const p = await locked(COPILOT_ONLY, copilotTools());
    const copilot = JSON.parse(fileOf(planFor(p, "copilot"), COPILOT_HOOKS));
    expect(Object.keys(copilot.hooks)).toEqual(["preToolUse", "sessionStart"]);
  });

  test("a gate in a rule file without contract fields keeps a version 2 policy for Copilot", async () => {
    if (windows) return;
    const p = await locked(
      {
        ...COPILOT_ONLY,
        "policies/base.yaml": `${RESOURCES["policies/base.yaml"]}- gate: Reviewed
  tool: files
  operation: file.write
  resource: { kind: file, match: any }
  requires: [{ agent: publisher, verdict: pass }]
  otherwise: deny
`,
      },
      copilotTools(),
    );
    const copilot = JSON.parse(fileOf(planFor(p, "copilot"), COPILOT_HOOKS));
    expect(copilot.hooks.subagentStop).toBeDefined();
  });

  test("contracts declared in a rule file as well as nodrail.yaml are refused", async () => {
    const p = project({
      ...FILES,
      "policies/base.yaml": `${POLICY}- contracts: { shapes: {}, receipts: {} }\n`,
    });
    const lock = await p.run("policy", "lock");
    expect(lock.code).toBe(1);
    expect(lock.err).toContain(
      "policies/base.yaml declares a contracts entry, and nodrail.yaml declares contracts too: declare them once, in nodrail.yaml.",
    );
  });

  test("a rule file can't hold a reviewer contract that drifts from nodrail.yaml (QA L2-07)", async () => {
    // The repro: the rule file repeats the receipt without one verdict that
    // nodrail.yaml declares, so the agent file would teach a verdict the hook
    // refuses. Declared once, in nodrail.yaml, or refused.
    const p = project({
      ...FILES,
      "policies/base.yaml": POLICY.replace(
        "- required_engine_version: 4\n",
        `- required_engine_version: 4
- contracts:
    shapes:
      reviewer-result:
        properties:
          verdict: { values: [ship], role: verdict }
          issue: { type: string, max: 100 }
          findings: { role: findings, report: true, properties: { blocker: { type: integer, min: 0 } } }
    receipts:
      reviewer: { shape: reviewer-result }
    agents:
      publisher: { receipt: reviewer }
`,
      ),
    });
    const lock = await p.run("policy", "lock");
    expect(lock.code).toBe(1);
    expect(lock.err).toContain(
      "policies/base.yaml declares a contracts entry, and nodrail.yaml declares contracts too",
    );
    expect(
      (await p.run("apply", "--yes", "--runtime", "claude-code")).code,
    ).not.toBe(0);
  });

  test("declared shapes nothing uses leave the policy as it was; a brief alone goes to the hook", async () => {
    const shapesOnly = `${RESOURCES["nodrail.yaml"]}${SHAPES.replace(/receipts:[\s\S]*$/, "")}`;
    const p = await locked({ ...RESOURCES, "nodrail.yaml": shapesOnly });
    const plain = await locked();
    const effective = (q: typeof p) =>
      fileOf(planFor(q, "claude-code"), ".nodrail/effective.yaml");
    expect(effective(p)).toBe(effective(plain));
    // The object form of spec.brief travels as written: the hook reads a
    // header brief with its aliases.
    const briefed = await locked({
      ...RESOURCES,
      "resources/agents.yaml": RESOURCES["resources/agents.yaml"].replace(
        "skills: [../skills/release-notes]",
        "skills: [../skills/release-notes]\n  brief: { shape: brief-shape, format: header, header: { aliases: { ticket: issue } } }",
      ),
      "nodrail.yaml": shapesOnly,
    });
    const text = effective(briefed);
    const items = parse(text) as Record<string, any>[];
    expect(items[1]!.contracts).toEqual({
      shapes: { "brief-shape": parse(SHAPES).shapes["brief-shape"] },
      agents: {
        lead: {
          brief: {
            shape: "brief-shape",
            format: "header",
            header: { aliases: { ticket: "issue" } },
          },
        },
      },
    });
    expect(hookDocument(text).briefs.lead).toMatchObject({
      name: "brief-shape",
      format: "header",
      aliases: { ticket: "issue" },
    });
  });
});

describe.skipIf(windows)("the hook enforces the receipt", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("a gate waits for a valid receipt whose values meet its where", async () => {
    const p = await locked(FILES);
    // The hook keeps its run ledger in the project, not in ~/.nodrail.
    vi.stubEnv("NODRAIL_LEDGER", join(p.cwd, ".ledger"));
    const session = `contracts-${Date.now()}`;
    let steps = 0;
    expect(
      (await p.run("apply", "--yes", "--runtime", "claude-code")).code,
    ).toBe(0);
    const policy = join(p.cwd, ".nodrail/effective.yaml");
    const event = async (body: object) => {
      const { out } = await p.runWith(
        { stdin: JSON.stringify({ session_id: session, cwd: p.cwd, ...body }) },
        "policy",
        "hook",
        policy,
        "--agent",
        "lead",
      );
      return out;
    };
    const write = async () => {
      const out = await event({
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: { file_path: join(p.cwd, "notes.md"), content: "x" },
      });
      return out
        ? JSON.parse(out).hookSpecificOutput.permissionDecision
        : "allow";
    };
    const step = async (receipt: string) => {
      steps += 1;
      await event({
        hook_event_name: "SubagentStart",
        agent_id: `a-${steps}`,
        agent_type: "publisher",
      });
      await event({
        hook_event_name: "SubagentStop",
        agent_id: `a-${steps}`,
        agent_type: "publisher",
        last_assistant_message: `Reviewed.\n\n\`\`\`nodrail-receipt\n${receipt}\n\`\`\`\n`,
      });
    };
    expect(await write()).toBe("deny");
    // A verdict word alone is no longer enough: blocker is text, not a count.
    await step(
      'agent: publisher\nverdict: ship\nissue: ENG-1\nfindings: { blocker: "0" }',
    );
    expect(await write()).toBe("deny");
    // Valid, but a blocker is open: the where isn't met.
    await step(
      "agent: publisher\nverdict: ship\nissue: ENG-1\nfindings: { blocker: 2 }",
    );
    expect(await write()).toBe("deny");
    await step(
      "agent: publisher\nverdict: ship\nissue: ENG-12\nfindings: { blocker: 0 }",
    );
    expect(await write()).toBe("allow");
    expect(existsSync(join(p.cwd, ".ledger"))).toBe(true);
  });
});
