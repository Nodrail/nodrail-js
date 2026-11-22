import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { Env } from "../config.ts";
import { sha256 } from "../project/lockfile.ts";
import {
  isPolicyHook,
  isNodrailHook,
  MCP_FILE,
  OBSERVE_PREFIX,
  SETTINGS_FILE,
} from "./claude-code.ts";
import { missingHooks } from "./hook-drift.ts";
import type { HookInfo } from "./codex.ts";
import { readBytes } from "./steps.ts";
import type { HostState, Runtime } from "./state.ts";

/**
 * What is on this machine for a host, next to what nodrail set up: the
 * drift since apply, and the agents, skills, MCP servers, plugins and hooks
 * nodrail doesn't manage, here and for the user. Only names and places are
 * read out: never a file's contents, a command's environment or a secret.
 * Nothing is changed, and nothing leaves the machine.
 */

/** A difference from what apply last wrote. */
export type Drift = {
  path: string;
  change: "edited" | "missing" | "changed";
  detail: string;
};

/** Something the host loads that nodrail didn't set up. */
export type Unmanaged = {
  kind: "agent" | "skill" | "MCP server" | "plugin" | "hook";
  name: string;
  /** "project", or "user": every folder this person opens. */
  scope: "project" | "user";
  where: string;
};

type Json = Record<string, unknown>;

const object = (value: unknown): Json | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : null;

export function json(path: string): Json | null {
  try {
    return object(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

const list = (folder: string) => {
  try {
    return readdirSync(folder, { withFileTypes: true }).filter(
      (entry) => !entry.name.startsWith("."),
    );
  } catch {
    return [];
  }
};

/** Each file nodrail wrote, as it is now. */
export function fileDrift(root: string, entry: HostState): Drift[] {
  return Object.entries(entry.files).flatMap(([path, hash]): Drift[] => {
    const disk = readBytes(root, path);
    if (disk === null)
      return [
        { path, change: "missing", detail: "written by apply, now gone" },
      ];
    if (disk === "folder" || sha256(disk) !== hash)
      return [
        { path, change: "edited", detail: "changed since apply wrote it" },
      ];
    return [];
  });
}

const textOf = (value: unknown) => (typeof value === "string" ? value : null);

const isOurs = isNodrailHook;

/** Every hook command in a Claude Code settings object, by event. */
function claudeHooks(settings: Json | null) {
  const hooks = object(settings?.hooks) ?? {};
  return Object.entries(hooks).flatMap(([event, groups]) =>
    (Array.isArray(groups) ? groups : []).flatMap((group) =>
      ((object(group)?.hooks as unknown[] | undefined) ?? []).map((hook) => ({
        event,
        matcher: textOf(object(group)?.matcher),
        command:
          textOf(object(hook)?.command) ?? textOf(object(hook)?.type) ?? "?",
      })),
    ),
  );
}

/** Claude Code's shared settings, against the entries nodrail set. */
export function claudeSettingsDrift(root: string, entry: HostState): Drift[] {
  const settings = json(join(root, SETTINGS_FILE));
  const ours = entry.settings;
  const changed = (path: string, detail: string): Drift => ({
    path,
    change: "changed",
    detail,
  });
  const drift: Drift[] = [];
  const policyHooks = claudeHooks(settings).filter((hook) =>
    isPolicyHook(hook.command),
  );
  if (policyHooks.length === 0)
    drift.push(changed(SETTINGS_FILE, "nodrail's policy hook is gone"));
  else
    for (const [event, detail] of missingHooks(root, policyHooks))
      drift.push(
        changed(SETTINGS_FILE, `the policy hook on ${event} ${detail}`),
      );
  if (policyHooks.some((hook) => !hook.command.includes("--protect-list")))
    drift.push(
      changed(SETTINGS_FILE, "the policy hook no longer has its protect list"),
    );
  if (settings?.disableAllHooks === true)
    drift.push(
      changed(SETTINGS_FILE, "disableAllHooks is on, so no hook runs"),
    );
  if (ours.agent !== undefined && settings?.agent !== ours.agent)
    drift.push(
      changed(
        SETTINGS_FILE,
        `starts as ${textOf(settings?.agent) ?? "no agent"}, not ${ours.agent}`,
      ),
    );
  return [
    ...drift,
    ...switchedOff(root, settings, ours).map(([path, detail]) =>
      changed(path, detail),
    ),
  ];
}

/** nodrail's connections and plugins no longer there or switched on. */
function switchedOff(
  root: string,
  settings: Json | null,
  ours: HostState["settings"],
) {
  const enabled = Array.isArray(settings?.enabledMcpjsonServers)
    ? (settings.enabledMcpjsonServers as unknown[])
    : [];
  const servers = object(json(join(root, MCP_FILE))?.mcpServers) ?? {};
  const plugins = object(settings?.enabledPlugins) ?? {};
  return [
    ...(ours.mcpServers ?? []).flatMap((name) => [
      ...(name in servers
        ? []
        : [[MCP_FILE, `connection ${name} is gone`] as const]),
      ...(enabled.includes(name)
        ? []
        : [[SETTINGS_FILE, `connection ${name} isn't switched on`] as const]),
    ]),
    ...(ours.plugins ?? [])
      .filter((name) => plugins[name] !== true)
      .map(
        (name) => [SETTINGS_FILE, `plugin ${name} isn't switched on`] as const,
      ),
  ];
}

/** Agents and skills in a host's folders, as names, apart from nodrail's. */
export function definitions(
  {
    base,
    shown,
    scope,
  }: { base: string; shown: string; scope: Unmanaged["scope"] },
  owned: (path: string) => boolean,
  places: { agents?: { folder: string; ending: string }; skills: string[] },
): Unmanaged[] {
  const found: Unmanaged[] = [];
  if (places.agents) {
    const { folder, ending } = places.agents;
    for (const file of list(join(base, folder)))
      if (
        file.isFile() &&
        file.name.endsWith(ending) &&
        !owned(`${folder}/${file.name}`)
      )
        found.push({
          kind: "agent",
          name: file.name.slice(0, -ending.length),
          scope,
          where: `${shown}/${folder}`,
        });
  }
  for (const folder of places.skills)
    for (const skill of list(join(base, folder)))
      if (skill.isDirectory() && !owned(`${folder}/${skill.name}/SKILL.md`))
        found.push({
          kind: "skill",
          name: skill.name,
          scope,
          where: `${shown}/${folder}`,
        });
  return found;
}

type Place = { base: string; shown: string; scope: Unmanaged["scope"] };

/** A host's project and user places, and which files nodrail wrote. */
export function hostPlaces(
  root: string,
  entry: HostState | null,
  user: { base: string; shown: string },
) {
  return {
    owned: (path: string) => entry?.files[path] !== undefined,
    project: { base: root, shown: ".", scope: "project" } as Place,
    user: { ...user, scope: "user" } as Place,
  };
}

/** The agents (`agents/*.md`) and skills in a host's user folder. */
export const userDefinitions = (user: Place) =>
  definitions(user, () => false, {
    agents: { folder: "agents", ending: ".md" },
    skills: ["skills"],
  });

/** Claude Code's user folder: CLAUDE_CONFIG_DIR, or ~/.claude. */
const claudeHome = (env: Env, home: string) =>
  env.CLAUDE_CONFIG_DIR ?? join(home, ".claude");

/** What Claude Code loads here that nodrail didn't set up. */
export function claudeUnmanaged(input: {
  root: string;
  home: string;
  env: Env;
  entry: HostState | null;
}): Unmanaged[] {
  const { root, entry } = input;
  const ours = entry?.settings ?? {};
  const user = claudeHome(input.env, input.home);
  const shownUser = input.env.CLAUDE_CONFIG_DIR ?? "~/.claude";
  const places = hostPlaces(root, entry, { base: user, shown: shownUser });
  return [
    ...definitions(places.project, places.owned, {
      agents: { folder: ".claude/agents", ending: ".md" },
      skills: [".claude/skills"],
    }),
    ...userDefinitions(places.user),
    ...claudeServers(input, ours, { user, shownUser }),
    ...claudeSettingsItems(root, ours, { user, shownUser }),
  ];
}

/** MCP servers in .mcp.json and in Claude Code's own state file, not nodrail's. */
function claudeServers(
  input: { root: string; home: string; env: Env },
  ours: HostState["settings"],
  { user, shownUser }: { user: string; shownUser: string },
) {
  const found: Unmanaged[] = [];
  const servers = (
    where: string,
    scope: Unmanaged["scope"],
    value: unknown,
    mine: string[] = [],
  ) => {
    for (const name of Object.keys(object(value) ?? {}))
      if (!mine.includes(name))
        found.push({ kind: "MCP server", name, scope, where });
  };
  servers(
    MCP_FILE,
    "project",
    json(join(input.root, MCP_FILE))?.mcpServers,
    ours.mcpServers,
  );
  // ~/.claude.json, or .claude.json in CLAUDE_CONFIG_DIR: the user's
  // servers, and the ones added for this folder alone.
  const custom = input.env.CLAUDE_CONFIG_DIR !== undefined;
  const state = json(
    custom ? join(user, ".claude.json") : join(input.home, ".claude.json"),
  );
  const shown = custom ? `${shownUser}/.claude.json` : "~/.claude.json";
  servers(shown, "user", state?.mcpServers);
  servers(
    `${shown} (this folder)`,
    "project",
    object(object(state?.projects)?.[realpathSync(input.root)])?.mcpServers,
  );
  return found;
}

/** Hooks and plugins in Claude Code's settings files, not nodrail's. */
function claudeSettingsItems(
  root: string,
  ours: HostState["settings"],
  { user, shownUser }: { user: string; shownUser: string },
) {
  const places = [
    [join(root, SETTINGS_FILE), SETTINGS_FILE, "project"],
    [
      join(root, ".claude/settings.local.json"),
      ".claude/settings.local.json",
      "project",
    ],
    [join(user, "settings.json"), `${shownUser}/settings.json`, "user"],
  ] as const;
  return places.flatMap(([path, where, scope]): Unmanaged[] => {
    const settings = json(path);
    const hooks = claudeHooks(settings)
      .filter((hook) => !isOurs(hook.command))
      .map((hook): Unmanaged => ({
        kind: "hook",
        name: `${hook.event}: ${short(hook.command)}`,
        scope,
        where,
      }));
    const plugins = Object.entries(object(settings?.enabledPlugins) ?? {})
      .filter(
        ([name, on]) => on === true && !(ours.plugins ?? []).includes(name),
      )
      .map(([name]): Unmanaged => ({ kind: "plugin", name, scope, where }));
    return [...hooks, ...plugins];
  });
}

/** A command, shortened to what identifies it. */
const short = (command: string) =>
  command.length > 60 ? `${command.slice(0, 57)}...` : command;

/** Codex's user folder: CODEX_HOME, or ~/.codex. */
const codexHome = (env: Env, home: string) =>
  env.CODEX_HOME ?? join(home, ".codex");

/**
 * TOML tables such as `mcp_servers.docs`, read without a TOML parser, and
 * whether each is switched off (`enabled = false`).
 */
function tables(text: string) {
  const heads = [...text.matchAll(/^[ \t]*\[([^\]]+)\][ \t]*$/gm)];
  return heads.map((head, index) => {
    const body = text.slice(
      head.index + head[0].length,
      heads[index + 1]?.index ?? text.length,
    );
    return {
      name: head[1]!.trim().replace(/"/g, ""),
      off: /^[ \t]*enabled[ \t]*=[ \t]*false\b/m.test(body),
    };
  });
}

/** What Codex loads here that nodrail didn't set up; its hooks as Codex listed them. */
export function codexUnmanaged(input: {
  root: string;
  home: string;
  env: Env;
  entry: HostState | null;
  hooks: HookInfo[] | null;
  ourHook: string | null;
}): Unmanaged[] {
  const { root, entry } = input;
  const owned = (path: string) => entry?.files[path] !== undefined;
  const user = codexHome(input.env, input.home);
  const shownUser = input.env.CODEX_HOME ?? "~/.codex";
  const found: Unmanaged[] = [
    ...definitions({ base: root, shown: ".", scope: "project" }, owned, {
      agents: { folder: ".codex/agents", ending: ".toml" },
      skills: [".agents/skills"],
    }),
    ...definitions(
      { base: user, shown: shownUser, scope: "user" },
      () => false,
      { skills: ["skills"] },
    ),
    ...definitions(
      { base: input.home, shown: "~", scope: "user" },
      () => false,
      { skills: [".agents/skills"] },
    ),
  ];
  let config = "";
  try {
    config = readFileSync(join(user, "config.toml"), "utf8");
  } catch {
    config = "";
  }
  for (const { name: table, off } of tables(config)) {
    if (off) continue;
    const server = /^mcp_servers\.([^.]+)$/.exec(table);
    if (server)
      found.push({
        kind: "MCP server",
        name: server[1]!,
        scope: "user",
        where: `${shownUser}/config.toml`,
      });
    const plugin = /^plugins\.([^.]+@[^.]+)$/.exec(table);
    if (plugin)
      found.push({
        kind: "plugin",
        name: plugin[1]!,
        scope: "user",
        where: `${shownUser}/config.toml`,
      });
  }
  found.push(...otherCodexHooks(input.hooks, input.ourHook));
  return found;
}

/** The hooks Codex listed that aren't nodrail's: its policy hook, or an observation. */
function otherCodexHooks(
  hooks: HookInfo[] | null,
  ours: string | null,
): Unmanaged[] {
  return (hooks ?? [])
    .filter(
      (hook) =>
        hook.command !== ours &&
        !(hook.command ?? "").startsWith(OBSERVE_PREFIX),
    )
    .map((hook) => ({
      kind: "hook",
      name: `${hook.eventName ?? "?"}: ${short(hook.command ?? "?")}`,
      scope: hook.source === "project" ? "project" : "user",
      where: hook.source ?? "?",
    }));
}

/** The hook command apply wrote for Codex, as it is on disk now. */
export function appliedCodexHook(root: string) {
  const hooks = json(join(root, ".codex/hooks.json"));
  const groups =
    (object(hooks?.hooks)?.PreToolUse as unknown[] | undefined) ?? [];
  for (const group of groups)
    for (const hook of (object(group)?.hooks as unknown[] | undefined) ?? []) {
      const command = object(hook)?.command;
      if (
        typeof command === "string" &&
        command.startsWith("nodrail policy hook ")
      )
        return command;
    }
  return null;
}

/** The agent a Codex hook command names, which is the entry agent. */
export const hookAgent = (command: string | null) =>
  command ? (/--agent (\S+)/.exec(command)?.[1] ?? null) : null;

export type { Runtime };
