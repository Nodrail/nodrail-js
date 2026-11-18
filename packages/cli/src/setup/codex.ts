import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import type { ProjectSetup, SetupAgent } from "@nodrail/policy-engine/yaml";
import type { Env } from "../config.ts";
import {
  byPath,
  EFFECTIVE_FILE,
  instructionsOf,
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

/** One argument for the shell Codex runs hooks with, quoted. */
const quoted = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;

/** A TOML basic string. JSON's escapes are all valid TOML ones. */
const tomlString = (text: string) => JSON.stringify(text);

/**
 * Codex's hook command. Codex runs hooks in the session's folder and lets a
 * call through when a hook fails, whatever its exit code; only a deny
 * answer blocks. So the policy is named by its full path, and when nodrail
 * can't run at all, the shell answers deny in its place.
 */
export function codexHookCommand(root: string, entry: string) {
  const real = realpathSync(root);
  const policy = join(real, EFFECTIVE_FILE);
  const list = join(real, PROTECT_LIST);
  return `nodrail policy hook ${quoted(policy)} --protect-list ${quoted(list)} --host codex --agent ${entry} || printf '%s' ${quoted(DENY)}`;
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
}) {
  const { root } = input;
  const parts = teamFiles({
    ...input,
    skillsFolder: ".agents/skills",
    hostPlaces: [".codex", ".agents"],
  });
  const { team } = parts;
  const files: DesiredFile[] = [...parts.files];
  const problems = [...parts.problems];
  if (process.platform === "win32")
    problems.push("Setting up Codex on Windows isn't supported yet.");
  const entry = parts.members.find((agent) => agent.name === team.entry)!;
  files.push({
    path: CODEX_CONFIG,
    content: Buffer.from(configFile(root, entry, team.name)),
    why: `start as ${entry.name}; agents on`,
  });
  for (const agent of parts.members)
    if (agent.name !== team.entry)
      files.push({
        path: `.codex/agents/${agent.name}.toml`,
        content: Buffer.from(agentFile(root, agent, team.name)),
        why: `agent ${agent.name}`,
      });
  files.push({
    path: CODEX_HOOKS,
    content: Buffer.from(
      `${JSON.stringify(
        {
          hooks: {
            PreToolUse: [
              {
                matcher: ".*",
                hooks: [
                  {
                    type: "command",
                    command: codexHookCommand(root, team.entry),
                  },
                ],
              },
            ],
          },
        },
        null,
        2,
      )}\n`,
    ),
    why: "the policy hook",
  });
  return {
    files: files.sort(byPath),
    problems,
    skipped: parts.skipped,
    entry: team.entry,
  };
}

const header = (from: string) =>
  `# Written by nodrail apply from ${from}. Change that file, not this one.\n`;

/** The project's Codex config: the session is the entry agent. */
function configFile(root: string, entry: SetupAgent, team: string) {
  const lines = [
    header(entry.file).trimEnd(),
    `developer_instructions = ${tomlString(instructionsOf(root, entry, team))}`,
  ];
  if (entry.model) lines.push(`model = ${tomlString(entry.model)}`);
  lines.push("", "[agents]", "enabled = true");
  return `${lines.join("\n")}\n`;
}

function agentFile(root: string, agent: SetupAgent, team: string) {
  const lines = [
    header(agent.file).trimEnd(),
    `name = ${tomlString(agent.name)}`,
    `description = ${tomlString(agent.description ?? `The ${agent.name} agent of team ${team}.`)}`,
    `developer_instructions = ${tomlString(instructionsOf(root, agent, team))}`,
  ];
  if (agent.model) lines.push(`model = ${tomlString(agent.model)}`);
  return `${lines.join("\n")}\n`;
}

/** Whether Codex runs nodrail's hook here, and if not, what to do. */
export type Activation = { active: boolean; detail: string };

type HookInfo = {
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
}): Promise<Activation> {
  const command = codexHookCommand(input.root, input.entry);
  let hooks: HookInfo[];
  try {
    hooks = await listHooks(input.codex, input.root, input.env);
  } catch (error) {
    return {
      active: false,
      detail: `couldn't ask Codex which hooks it runs: ${(error as Error).message}`,
    };
  }
  const project = hooks.filter((hook) => hook.source === "project");
  const ours = project.find(
    (hook) => hook.eventName === "preToolUse" && hook.command === command,
  );
  if (ours?.trustStatus === "trusted")
    return { active: true, detail: "Codex runs nodrail's hook here" };
  if (ours)
    return {
      active: false,
      detail: `nodrail's hook is ${ours.trustStatus ?? "not trusted"}. Open codex here, run /hooks and trust it`,
    };
  if (project.length === 0)
    return {
      active: false,
      detail:
        "Codex doesn't load this folder's hooks until you trust the folder: open codex here and trust it, then run /hooks and trust nodrail's hook",
    };
  return {
    active: false,
    detail: "Codex doesn't list nodrail's hook here yet; run nodrail apply",
  };
}

const TIMEOUT = 30_000;

/** `hooks/list` over the app server's JSON lines, then the server is stopped. */
function listHooks(codex: string, cwd: string, env: Env) {
  return new Promise<HookInfo[]>((resolve, reject) => {
    const server = spawn(codex, ["app-server"], {
      cwd,
      env: env as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "ignore"],
    });
    let settled = false;
    const done = (error: Error | null, hooks: HookInfo[] = []) => {
      // Stopping the server below ends it too: answer once.
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.kill();
      if (error) reject(error);
      else resolve(hooks);
    };
    const timer = setTimeout(
      () => done(new Error("no answer in 30 seconds")),
      TIMEOUT,
    );
    const send = (message: object) =>
      server.stdin.write(`${JSON.stringify(message)}\n`);
    let buffer = "";
    server.on("error", (error) => done(error));
    server.on("exit", () => done(new Error("the app server stopped")));
    server.stdout.on("data", (data: Buffer) => {
      buffer += data.toString("utf8");
      let at: number;
      while ((at = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        let message: {
          id?: number;
          result?: unknown;
          error?: { message?: string };
        };
        try {
          message = JSON.parse(line) as typeof message;
        } catch {
          continue;
        }
        if (message.id === 1) {
          send({ method: "initialized" });
          send({ id: 2, method: "hooks/list", params: { cwds: [cwd] } });
        } else if (message.id === 2) {
          if (message.error)
            return done(
              new Error(message.error.message ?? "hooks/list failed"),
            );
          const data = (message.result as { data?: { hooks?: HookInfo[] }[] })
            ?.data;
          return done(
            null,
            (data ?? []).flatMap((entry) => entry.hooks ?? []),
          );
        }
      }
    });
    send({
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "nodrail", version: "0" } },
    });
  });
}
