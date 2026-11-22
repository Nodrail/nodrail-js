import { claudeMarketplace, claudePluginSettings } from "./plugins.ts";
import { stringify } from "yaml";
import {
  compilePolicies,
  type ProjectSetup,
  type SetupAgent,
} from "@nodrail/policy-engine/yaml";
import { evidenceRead } from "./accountable.ts";
import { hookReads, mcpServerEntries } from "./connections.ts";
import type { Env } from "../config.ts";
import type { CompiledContracts } from "../contracts/engine.ts";
import {
  byPath,
  PROTECT_LIST,
  teamFiles,
  type DesiredFile,
} from "./team-files.ts";

export { EFFECTIVE_FILE, type DesiredFile } from "./team-files.ts";
export const SETTINGS_FILE = ".claude/settings.json";
/** The project's MCP servers, which Claude Code starts once switched on. */
export const MCP_FILE = ".mcp.json";
/** The first Claude Code whose hooks take `onFailure: "block"`. */
export const MIN_CLAUDE = "2.1.295";

/** What nodrail sets in Claude Code's settings, next to anything else there. */
export type DesiredSettings = {
  agent: string;
  hook: HookGroup;
  /** `.mcp.json` entries for the connections, by name. */
  mcpServers: Record<string, unknown>;
  /** The project's plugin marketplace, and the plugins it switches on. */
  plugins: {
    marketplaces: Record<string, unknown>;
    enabled: Record<string, boolean>;
  };
  /** The session-start hook that records an observation, unless turned off. */
  observe: HookGroup | null;
  /**
   * The same policy hook on SubagentStart and SubagentStop, which record a
   * run's steps: only when the policy has gates, budgets or receipt
   * contracts, which need them.
   */
  steps: HookGroup | null;
  /**
   * The same policy hook on PostToolUse and PostToolUseFailure, which settle
   * a call's numeric budget reservations: only when the policy has numeric
   * budgets, which need them.
   */
  settle: HookGroup | null;
};
type HookGroup = {
  matcher?: string;
  hooks: { type: "command"; command: string; onFailure?: "block" }[];
};

/** Hook events nodrail sets in Claude Code's settings, besides PreToolUse. */
export const STEP_EVENTS = ["SubagentStart", "SubagentStop"] as const;

/** Outcome events: the hook settles budgets on them (never judges a call). */
export const SETTLE_EVENTS = ["PostToolUse", "PostToolUseFailure"] as const;

/**
 * Whether the effective policy records runs: every document past version 1.
 * Version 2 has gates or budgets; version 3 adds declared receipts, read
 * when a subagent stops. A later one needs them as much.
 */
export const usesRuns = (effective: string) => {
  const compiled = compilePolicies([
    { name: "effective.apf.yaml", text: effective },
  ]);
  return compiled.ok && compiled.document.version !== 1;
};

/**
 * Whether the effective policy has numeric budgets (engine level 5): their
 * reservations settle on a call's outcome, so the hook must see it too.
 */
export const usesLimits = (effective: string) => {
  const compiled = compilePolicies([
    { name: "effective.apf.yaml", text: effective },
  ]);
  return (
    compiled.ok &&
    compiled.document.version === 4 &&
    compiled.document.limits.length > 0
  );
};

/** How nodrail's own hook command starts, to find it among others. */
export const HOOK_PREFIX = `nodrail policy hook "$CLAUDE_PROJECT_DIR/.nodrail/`;

/** How the session-start observation's command starts, on both hosts. */
export const OBSERVE_PREFIX = "nodrail observe ";

/** Whether a hook command is one of nodrail's own. */
export const isNodrailHook = (command: unknown) =>
  typeof command === "string" &&
  (command.startsWith(HOOK_PREFIX) || command.startsWith(OBSERVE_PREFIX));

/** The observation command, for a project the host names by `root`. */
export const observeCommand = (
  root: string,
  setup: Pick<ProjectSetup, "observe">,
) =>
  `${OBSERVE_PREFIX}${root} --detach${setup.observe.names ? " --names" : ""}`;

export type ClaudeSetup = {
  files: DesiredFile[];
  settings: DesiredSettings;
  problems: string[];
  /** Declared agents left out because they aren't on the team. */
  skipped: string[];
};

/**
 * What Claude Code needs to run the team: an agent file per member, the
 * skills they use, the effective policy, and settings that start the session
 * as the entry agent with the policy hook in front of every tool call. The
 * hook blocks when it can't run, so a missing `nodrail` stops calls rather
 * than letting them through.
 */
export function claudeCodeSetup(input: {
  root: string;
  setup: ProjectSetup;
  effective: string;
  inputs: string[];
  contracts?: CompiledContracts | null;
  /** Where the hook asks Cloud about evidence (NODRAIL_URL). */
  env?: Env;
}): ClaudeSetup {
  const { root } = input;
  const parts = teamFiles({
    ...input,
    skillsFolder: ".claude/skills",
  });
  const { team } = parts;
  const files = [...parts.files, ...claudeMarketplace(input.setup)];
  for (const agent of parts.members)
    files.push({
      path: `.claude/agents/${agent.name}.md`,
      content: Buffer.from(
        agentFile(
          agent,
          team.name,
          parts.skills.get(agent.name)!,
          parts.body(agent),
        ),
      ),
      why: `agent ${agent.name}`,
    });
  const connections = input.setup.connections;
  const reads = hookReads(
    input.setup,
    (file) => `"$CLAUDE_PROJECT_DIR/${file}"`,
  );
  const evidence = evidenceRead(
    input,
    (file) => `"$CLAUDE_PROJECT_DIR/${file}"`,
  );
  const command = `${HOOK_PREFIX}effective.apf.yaml" --protect-list "$CLAUDE_PROJECT_DIR/${PROTECT_LIST}"${reads}${evidence} --agent ${team.entry}`;
  // Claude Code starts a project server in the project folder; the runner
  // finds the file by its full path anyway.
  const mcpServers = mcpServerEntries(root, connections, { type: "stdio" });
  return {
    files: files.sort(byPath),
    settings: {
      agent: team.entry,
      mcpServers,
      plugins: claudePluginSettings(root, input.setup),
      hook: {
        matcher: "*",
        hooks: [{ type: "command", command, onFailure: "block" }],
      },
      steps: usesRuns(input.effective)
        ? { hooks: [{ type: "command", command }] }
        : null,
      // An outcome is recorded, never judged: a failure here mustn't block.
      settle: usesLimits(input.effective)
        ? { matcher: "*", hooks: [{ type: "command", command }] }
        : null,
      // Records what is set up at each session start; never blocks one.
      observe: input.setup.observe.sessionStart
        ? {
            hooks: [
              {
                type: "command",
                command: observeCommand(`"$CLAUDE_PROJECT_DIR"`, input.setup),
              },
            ],
          }
        : null,
    },
    problems: parts.problems,
    skipped: parts.skipped,
  };
}

function agentFile(
  agent: SetupAgent,
  team: string,
  skills: string[],
  body: string,
) {
  const front: Record<string, unknown> = {
    name: agent.name,
    description:
      agent.description ?? `The ${agent.name} agent of team ${team}.`,
  };
  if (agent.model) front.model = agent.model;
  // Preloads each skill whole, so the agent has its procedure from the start.
  if (skills.length > 0) front.skills = skills;
  return `---
# Written by nodrail apply from ${agent.file}. Change that file, not this one.
${stringify(front, { lineWidth: 0 })}---
${body}`;
}
