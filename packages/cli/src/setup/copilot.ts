import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { ProjectSetup, SetupAgent } from "@nodrail/policy-engine/yaml";
import { stringify } from "yaml";
import type { Env } from "../config.ts";
import type { CompiledContracts } from "../contracts/engine.ts";
import { observeCommand, usesLimits, usesRuns } from "./claude-code.ts";
import { hookReads, mcpServerEntries } from "./connections.ts";
import type { Check } from "./plan.ts";
import type { Activation } from "./status.ts";
import {
  byPath,
  EFFECTIVE_FILE,
  PROTECT_LIST,
  teamFiles,
  type DesiredFile,
} from "./team-files.ts";

/**
 * GitHub Copilot CLI (W5): agents in `.github/agents`, skills in
 * `.github/skills`, MCP servers in `.github/mcp.json`, and the policy hook
 * in `.github/hooks/nodrail.json`. Copilot runs the project's hooks only
 * once the person trusts the folder, and a hook that fails denies the call
 * (verified live with Copilot CLI 1.0.114). The session starts as the entry
 * agent with `copilot --agent <entry>`.
 */

export const COPILOT_HOOKS = ".github/hooks/nodrail.json";
export const COPILOT_MCP = ".github/mcp.json";
/** The Copilot CLI the setup was verified with. */
export const MIN_COPILOT = "1.0.114";

/** One argument for the shell Copilot runs hooks with, quoted. */
const quoted = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;

/** Copilot's hook command, by full paths: it fails closed if nodrail can't run. */
export function copilotHookCommand(
  root: string,
  entry: string,
  setup: ProjectSetup,
) {
  const real = realpathSync(root);
  const reads = hookReads(setup, (file) => quoted(join(real, file)));
  return `nodrail policy hook ${quoted(join(real, EFFECTIVE_FILE))} --protect-list ${quoted(join(real, PROTECT_LIST))}${reads} --host copilot --agent ${entry}`;
}

function agentFile(agent: SetupAgent, team: string, body: string) {
  const front = {
    name: agent.name,
    description:
      agent.description ?? `The ${agent.name} agent of team ${team}.`,
  };
  return `---
# Written by nodrail apply from ${agent.file}. Change that file, not this one.
${stringify(front, { lineWidth: 0 })}---
${body}`;
}

function hooksFile(
  root: string,
  entry: string,
  setup: ProjectSetup,
  effective: string,
) {
  const hook = (command: string) => [
    { type: "command", bash: command, timeoutSec: 20 },
  ];
  const policy = copilotHookCommand(root, entry, setup);
  const hooks = {
    preToolUse: hook(policy),
    // A run's steps, when the policy has gates, budgets or receipts: the
    // same hook reads Copilot's subagentStart and subagentStop, the final
    // text and its receipt in `response`.
    ...(usesRuns(effective)
      ? { subagentStart: hook(policy), subagentStop: hook(policy) }
      : {}),
    // Numeric budgets settle on a call's outcome: postToolUse carries it,
    // success or not, in `toolResult.resultType`.
    ...(usesLimits(effective) ? { postToolUse: hook(policy) } : {}),
    // Copilot asks the person to trust the folder once, then runs both.
    ...(setup.observe.sessionStart
      ? {
          sessionStart: hook(observeCommand(quoted(realpathSync(root)), setup)),
        }
      : {}),
  };
  return `${JSON.stringify({ version: 1, hooks }, null, 2)}\n`;
}

/** Each connection as an MCP server nodrail starts; secrets by name only. */
function mcpFile(root: string, setup: ProjectSetup) {
  const mcpServers = mcpServerEntries(root, setup.connections, {
    type: "local",
    tools: ["*"],
  });
  return `${JSON.stringify({ mcpServers }, null, 2)}\n`;
}

/** What Copilot needs to run the team: agents, skills, policy, hook, servers. */
export function copilotSetup(input: {
  root: string;
  setup: ProjectSetup;
  effective: string;
  inputs: string[];
  contracts?: CompiledContracts | null;
  env?: Env;
}) {
  const { root, setup } = input;
  const parts = teamFiles({ ...input, skillsFolder: ".github/skills" });
  const { team } = parts;
  const problems = [...parts.problems];
  if (process.platform === "win32")
    problems.push("Setting up Copilot on Windows isn't supported yet.");
  if (setup.plugins.length > 0)
    problems.push(
      "Plugins aren't set up for Copilot yet: run with --runtime claude-code or codex, or remove them.",
    );
  const files: DesiredFile[] = [...parts.files];
  for (const agent of parts.members)
    files.push({
      path: `.github/agents/${agent.name}.agent.md`,
      content: Buffer.from(agentFile(agent, team.name, parts.body(agent))),
      why: `agent ${agent.name}`,
    });
  files.push({
    path: COPILOT_HOOKS,
    content: Buffer.from(hooksFile(root, team.entry, setup, input.effective)),
    why: "the policy hook",
  });
  if (setup.connections.length > 0)
    files.push({
      path: COPILOT_MCP,
      content: Buffer.from(mcpFile(root, setup)),
      why: "the connections, as MCP servers nodrail starts",
    });
  return {
    files: files.sort(byPath),
    problems,
    skipped: parts.skipped,
    entry: team.entry,
  };
}

/** Copilot's home: COPILOT_HOME, else ~/.copilot. */
const copilotHome = (env: Env, home: string) =>
  env.COPILOT_HOME ?? join(home, ".copilot");

/**
 * Whether Copilot runs the hook here: it does once the person trusted the
 * folder (`trustedFolders` in Copilot's config.json), and nodrail never
 * trusts it for them. Copilot can't be asked which hooks it runs.
 */
export function copilotActivation(input: {
  root: string;
  home: string;
  env: Env;
}): Activation {
  let trusted: string[] = [];
  try {
    const config = JSON.parse(
      readFileSync(
        join(copilotHome(input.env, input.home), "config.json"),
        "utf8",
      ),
    ) as { trustedFolders?: unknown };
    if (Array.isArray(config.trustedFolders))
      trusted = config.trustedFolders.filter(
        (each): each is string => typeof each === "string",
      );
  } catch {
    // No config yet: nothing trusted.
  }
  const real = realpathSync(input.root);
  const inside = trusted.some((folder) => {
    try {
      const path = realpathSync(folder);
      return real === path || real.startsWith(`${path}/`);
    } catch {
      return false;
    }
  });
  return inside
    ? {
        state: "configured",
        detail:
          "the hook is in .github/hooks and you trusted this folder; Copilot can't be asked which hooks it runs",
      }
    : {
        state: "inactive",
        detail:
          "Copilot runs the project's hooks only in a trusted folder: open copilot here and choose to remember the folder",
      };
}

/**
 * Settings that switch every Copilot hook off, nodrail's included: the
 * repository's (Copilot also reads `.claude/settings*.json`) and the
 * person's. Administrator policy hooks run too, but they only add denies.
 */
export function copilotHookChecks(input: {
  root: string;
  home: string;
  env: Env;
}): Check[] {
  const files = [
    ".github/copilot/settings.json",
    ".github/copilot/settings.local.json",
    ".claude/settings.json",
    ".claude/settings.local.json",
  ].map((file) => join(input.root, file));
  files.push(join(copilotHome(input.env, input.home), "settings.json"));
  return files.flatMap((file) => {
    try {
      const settings = JSON.parse(readFileSync(file, "utf8")) as {
        disableAllHooks?: unknown;
      };
      return settings.disableAllHooks === true
        ? [
            {
              name: "hooks",
              ok: false,
              detail: `${file} sets disableAllHooks: Copilot would run no hook, nodrail's included`,
            },
          ]
        : [];
    } catch {
      return [];
    }
  });
}
