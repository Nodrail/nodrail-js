import { launcher, launchShell, shellArg as quoted } from "./launcher.ts";
import { connectRead } from "./connect.ts";
import { evidenceRead } from "./accountable.ts";
import { observeCommand, usesLimits } from "./claude-code.ts";
import { realpathSync } from "node:fs";
import { codexMarketplace, codexPluginLines } from "./plugins.ts";
import { join } from "node:path";
import type { ProjectSetup, SetupAgent } from "@nodrail/policy-engine/yaml";
import type { Env } from "../config.ts";
import type { CompiledContracts } from "../contracts/engine.ts";
import {
  CONNECTIONS_FILE,
  envNames,
  hookReads,
  runnerArgs,
} from "./connections.ts";
import type { Activation } from "./status.ts";
import { askServer } from "./json-lines.ts";
import {
  byPath,
  EFFECTIVE_FILE,
  PROTECT_LIST,
  teamFiles,
  type DesiredFile,
} from "./team-files.ts";

export const CODEX_CONFIG = ".codex/config.toml";
export const CODEX_HOOKS = ".codex/hooks.json";
/** The Codex the setup was verified with: hooks, hooks.json, agent files. */
export const MIN_CODEX = "0.169.0";

/** What a hook that can't run answers, so Codex blocks instead of going on. */
const DENY = JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason:
      "Nodrail: the policy hook could not run. Check that nodrail is installed, then run nodrail plan.",
  },
});

/** A TOML basic string. JSON's escapes are all valid TOML ones. */
const tomlString = (text: string) => JSON.stringify(text);

/**
 * Codex's hook command. Codex runs hooks in the session's folder and lets a
 * call through when a hook fails, whatever its exit code; only a deny
 * answer blocks. So the policy is named by its full path, and when nodrail
 * can't run at all, the shell answers deny in its place.
 */
export function codexHookCommand(
  root: string,
  entry: string,
  setup: Pick<ProjectSetup, "connections" | "telemetry"> &
    Partial<Pick<ProjectSetup, "plugins" | "connect">> = {
    connections: [],
    telemetry: null,
  },
  /** The effective policy, whose evidence requirements may ask Cloud. */
  policyText: { effective: string; env?: Env } = { effective: "" },
) {
  const real = realpathSync(root);
  const policy = join(real, EFFECTIVE_FILE);
  const list = join(real, PROTECT_LIST);
  const path = (file: string) => quoted(join(real, file));
  const reads = hookReads(setup as ProjectSetup, path);
  const evidence = setup.connect
    ? connectRead(setup, path)
    : evidenceRead({ root, ...policyText }, path);
  return `${launchShell} policy hook ${quoted(policy)} --protect-list ${quoted(list)}${reads}${evidence} --host codex --agent ${entry} || printf '%s' ${quoted(DENY)}`;
}

/**
 * What Codex needs to run the team: the entry agent's instructions in the
 * project's config, an agent file for each other member, the skills, the
 * effective policy, and the policy hook in `.codex/hooks.json`. Codex runs
 * none of the project's config or hooks until the person trusts the folder
 * and the hook; nodrail never does that for them (see `codexActivation`).
 */
export function codexSetup(input: {
  root: string;
  setup: ProjectSetup;
  effective: string;
  inputs: string[];
  contracts?: CompiledContracts | null;
  /** Where the hook asks Cloud about evidence (NODRAIL_URL). */
  env?: Env;
}) {
  const { root } = input;
  const parts = teamFiles({
    ...input,
    skillsFolder: ".agents/skills",
  });
  const { team } = parts;
  const files: DesiredFile[] = [
    ...parts.files,
    ...codexMarketplace(input.setup),
  ];
  const problems = [...parts.problems];
  if (process.platform === "win32")
    problems.push("Setting up Codex on Windows isn't supported yet.");
  const entry = parts.members.find((agent) => agent.name === team.entry)!;
  files.push({
    path: CODEX_CONFIG,
    content: Buffer.from(
      configFile(root, entry, parts.body(entry), input.setup),
    ),
    why: `start as ${entry.name}; agents on`,
  });
  for (const agent of parts.members)
    if (agent.name !== team.entry)
      files.push({
        path: `.codex/agents/${agent.name}.toml`,
        content: Buffer.from(agentFile(agent, team.name, parts.body(agent))),
        why: `agent ${agent.name}`,
      });
  files.push({
    path: CODEX_HOOKS,
    content: Buffer.from(hooksFile(root, team.entry, input.setup, input)),
    why: "the policy hook",
  });
  return {
    files: files.sort(byPath),
    problems,
    skipped: parts.skipped,
    entry: team.entry,
  };
}

/**
 * `.codex/hooks.json`: the policy hook, the observation at session start,
 * and, with numeric budgets, the same hook on PostToolUse to settle them.
 * Codex has no PostToolUseFailure: a failed call's reservation stays
 * unknown, and counted, until the person reconciles it.
 */
function hooksFile(
  root: string,
  entry: string,
  setup: ProjectSetup,
  policy: { effective: string; env?: Env },
) {
  const command = (line: string) => [{ type: "command", command: line }];
  const hook = codexHookCommand(root, entry, setup, policy);
  const hooks = {
    PreToolUse: [{ matcher: ".*", hooks: command(hook) }],
    ...(setup.connect?.decide === "cloud" || usesLimits(policy.effective)
      ? { PostToolUse: [{ matcher: ".*", hooks: command(hook) }] }
      : {}),
    // Codex asks the person to trust it once, in /hooks.
    ...(setup.observe.sessionStart
      ? {
          SessionStart: [
            {
              hooks: command(observeCommand(quoted(realpathSync(root)), setup)),
            },
          ],
        }
      : {}),
  };
  return `${JSON.stringify({ hooks }, null, 2)}\n`;
}

const header = (from: string) =>
  `# Written by nodrail apply from ${from}. Change that file, not this one.\n`;

/**
 * The project's Codex config: the session is the entry agent, and each
 * connection is an MCP server nodrail starts, with the names of its fromEnv
 * secrets passed through, never their values.
 */
function configFile(
  root: string,
  entry: SetupAgent,
  body: string,
  setup: ProjectSetup,
) {
  const lines = [
    header(entry.file).trimEnd(),
    `developer_instructions = ${tomlString(body)}`,
  ];
  if (entry.model) lines.push(`model = ${tomlString(entry.model)}`);
  lines.push("", "[agents]", "enabled = true");
  const file = join(realpathSync(root), CONNECTIONS_FILE);
  for (const { name, spec } of setup.connections) {
    lines.push(
      "",
      `[mcp_servers.${tomlString(name)}]`,
      `command = ${tomlString(launcher.command)}`,
      `args = ${JSON.stringify([...launcher.args, ...runnerArgs(file, name)])}`,
    );
    if (envNames(spec).length > 0)
      lines.push(`env_vars = ${JSON.stringify(envNames(spec))}`);
  }
  lines.push(...codexPluginLines(root, setup));
  return `${lines.join("\n")}\n`;
}

function agentFile(agent: SetupAgent, team: string, body: string) {
  const lines = [
    header(agent.file).trimEnd(),
    `name = ${tomlString(agent.name)}`,
    `description = ${tomlString(agent.description ?? `The ${agent.name} agent of team ${team}.`)}`,
    `developer_instructions = ${tomlString(body)}`,
  ];
  if (agent.model) lines.push(`model = ${tomlString(agent.model)}`);
  return `${lines.join("\n")}\n`;
}

/** Whether Codex runs nodrail's hook here, and if not, what to do. */

export type HookInfo = {
  source?: string;
  eventName?: string;
  command?: string;
  trustStatus?: string;
};

/**
 * Asks Codex itself, through its app server, which project hooks it would
 * run in this folder and whether each is trusted. It only reads: trust is
 * the person's to give, in Codex.
 */
export async function codexActivation(input: {
  root: string;
  codex: string;
  env: Env;
  entry: string;
  setup: Pick<ProjectSetup, "connections" | "telemetry"> &
    Partial<Pick<ProjectSetup, "plugins" | "connect">>;
  /** The effective policy apply wrote, for the hook's `--evidence`. */
  effective?: string;
}): Promise<Activation> {
  const command = codexHookCommand(input.root, input.entry, input.setup, {
    effective: input.effective ?? "",
    env: input.env,
  });
  const hooks = await codexHooks(input.codex, input.root, input.env);
  return typeof hooks === "string"
    ? { state: "unknown", detail: hooks }
    : hookActivation(hooks, command);
}

/** The hooks Codex would run here, from every source, or why it couldn't say. */
export async function codexHooks(
  codex: string,
  root: string,
  env: Env,
): Promise<HookInfo[] | string> {
  try {
    return await listHooks(codex, root, env);
  } catch (error) {
    return `couldn't ask Codex which hooks it runs: ${(error as Error).message}`;
  }
}

/** Whether Codex runs this hook command here, from what it listed. */
export function hookActivation(hooks: HookInfo[], command: string): Activation {
  const project = hooks.filter((hook) => hook.source === "project");
  const ours = project.find(
    (hook) => hook.eventName === "preToolUse" && hook.command === command,
  );
  if (ours?.trustStatus === "trusted")
    return { state: "verified", detail: "Codex runs nodrail's hook here" };
  if (ours)
    return {
      state: "inactive",
      detail: `nodrail's hook is ${ours.trustStatus ?? "not trusted"}. Open codex here, run /hooks and trust it`,
    };
  if (project.length === 0)
    return {
      state: "inactive",
      detail:
        "Codex doesn't load this folder's hooks until you trust the folder: open codex here and trust it, then run /hooks and trust nodrail's hook",
    };
  return {
    state: "inactive",
    detail: "Codex doesn't list nodrail's hook here yet; run nodrail apply",
  };
}

const TIMEOUT = 30_000;

/** `hooks/list` over the app server's JSON lines, then the server is stopped. */
function listHooks(codex: string, cwd: string, env: Env) {
  return askServer<HookInfo[]>({
    command: codex,
    args: ["app-server"],
    cwd,
    env,
    timeout: TIMEOUT,
    first: {
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "nodrail", version: "0" } },
    },
    answer: (message, send, finish) => {
      if (message.id === 1) {
        send({ method: "initialized" });
        send({ id: 2, method: "hooks/list", params: { cwds: [cwd] } });
      } else if (message.id === 2) {
        if (message.error)
          throw new Error(message.error.message ?? "hooks/list failed");
        const data = (message.result as { data?: { hooks?: HookInfo[] }[] })
          ?.data;
        finish((data ?? []).flatMap((entry) => entry.hooks ?? []));
      }
    },
  });
}
