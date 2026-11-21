import { readFileSync } from "node:fs";
import { join } from "node:path";
import { folderHost } from "../project/host.ts";
import {
  isNodrailHook,
  MCP_FILE,
  SETTINGS_FILE,
  STEP_EVENTS,
  type DesiredSettings,
} from "./claude-code.ts";
import type { HostState } from "./state.ts";

/** A step in the plan, as plan.ts defines it. */
type Action = "create" | "update" | "keep" | "conflict";
type MergedStep = {
  step: { path: string; action: Action; why: string };
  value: Record<string, unknown> | null;
};

/**
 * Claude Code's files that are shared with the person's own settings, with
 * nodrail's entries set and everything else kept: in settings.json, `agent`,
 * one PreToolUse hook found by its command, and the connections switched on;
 * in .mcp.json, the connections. An entry nodrail set before and no longer
 * needs is taken out; anyone else's stays.
 */
export function claudeSteps(
  root: string,
  ours: HostState["settings"] | undefined,
  want: DesiredSettings,
): MergedStep[] {
  const steps = [settingsStep(root, ours, want)];
  const before = ours?.mcpServers ?? [];
  if (Object.keys(want.mcpServers).length > 0 || before.length > 0)
    steps.push(mcpStep(root, before, want));
  return steps;
}

function settingsStep(
  root: string,
  ours: HostState["settings"] | undefined,
  want: DesiredSettings,
): MergedStep {
  const path = SETTINGS_FILE;
  const why = `start as ${want.agent}; the policy hook`;
  const read = readJson(root, path);
  const refusal =
    typeof read === "string" ? read : settingsRefusal(read.current, ours, want);
  if (refusal !== null || typeof read === "string")
    return conflict(path, `${why}; ${refusal}`);
  const { current } = read;
  const hooks = (current.hooks ?? {}) as Record<string, unknown>;
  const groups = Array.isArray(hooks.PreToolUse)
    ? (hooks.PreToolUse as unknown[])
    : [];
  const value: Record<string, unknown> = {
    ...current,
    agent: want.agent,
    hooks: ourHooks(hooks, groups, want),
  };
  const enabled = mergedNames(
    current.enabledMcpjsonServers,
    ours?.mcpServers ?? [],
    Object.keys(want.mcpServers),
  );
  if (enabled.length > 0 || current.enabledMcpjsonServers !== undefined)
    value.enabledMcpjsonServers = enabled;
  mergeEntries(
    value,
    "extraKnownMarketplaces",
    ours?.marketplaces ?? [],
    want.plugins.marketplaces,
  );
  mergeEntries(
    value,
    "enabledPlugins",
    ours?.plugins ?? [],
    want.plugins.enabled,
  );
  return step(path, why, read, value);
}

/** Settings' hooks with nodrail's set: the policy hook, observation, steps. */
function ourHooks(
  hooks: Record<string, unknown>,
  preToolUse: unknown[],
  want: DesiredSettings,
) {
  let all: Record<string, unknown> = {
    ...hooks,
    PreToolUse: [...withoutOurs(preToolUse), want.hook],
  };
  all = withOurs(all, "SessionStart", want.observe);
  for (const event of STEP_EVENTS) all = withOurs(all, event, want.steps);
  return all;
}

/** An event's hooks with nodrail's group set, or taken out; dropped once empty. */
function withOurs(
  hooks: Record<string, unknown>,
  event: string,
  group: unknown,
): Record<string, unknown> {
  const had = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
  const groups = [...withoutOurs(had), ...(group ? [group] : [])];
  const { [event]: _, ...rest } = hooks;
  return groups.length > 0 ? { ...rest, [event]: groups } : rest;
}

/**
 * An object setting with nodrail's entries set: those it set before and no
 * longer needs out, everyone else's kept. Left out when it ends up empty and
 * wasn't there.
 */
function mergeEntries(
  value: Record<string, unknown>,
  key: string,
  before: readonly string[],
  now: Record<string, unknown>,
) {
  const had = value[key];
  const entries = {
    ...(had !== null && typeof had === "object" && !Array.isArray(had)
      ? (had as Record<string, unknown>)
      : {}),
  };
  for (const name of before) delete entries[name];
  Object.assign(entries, now);
  if (Object.keys(entries).length > 0 || had !== undefined)
    value[key] = entries;
}

/** `.mcp.json`'s servers with nodrail's connections, everyone else's kept. */
function mcpStep(
  root: string,
  before: readonly string[],
  want: DesiredSettings,
): MergedStep {
  const path = MCP_FILE;
  const names = Object.keys(want.mcpServers);
  const why = names.length
    ? `the connections ${names.join(", ")}`
    : "connections no longer needed";
  const read = readJson(root, path);
  if (typeof read === "string") return conflict(path, `${why}; ${read}`);
  const { current } = read;
  const servers = {
    ...((current.mcpServers ?? {}) as Record<string, unknown>),
  };
  for (const name of names)
    if (Object.hasOwn(servers, name) && !before.includes(name))
      return conflict(
        path,
        `${why}; a server named ${name} is there, not written by nodrail`,
      );
  for (const name of before) delete servers[name];
  Object.assign(servers, want.mcpServers);
  return step(path, why, read, { ...current, mcpServers: servers });
}

/** A list with nodrail's names set: its earlier ones out, the new ones in. */
function mergedNames(
  current: unknown,
  before: readonly string[],
  now: string[],
) {
  const listed = Array.isArray(current)
    ? current.filter((name): name is string => typeof name === "string")
    : [];
  const kept = listed.filter(
    (name) => !before.includes(name) || now.includes(name),
  );
  return [...kept, ...now.filter((name) => !kept.includes(name))];
}

const conflict = (path: string, why: string): MergedStep => ({
  step: { path, action: "conflict", why },
  value: null,
});

function step(
  path: string,
  why: string,
  read: { disk: Buffer | null; current: Record<string, unknown> },
  value: Record<string, unknown>,
): MergedStep {
  const { disk, current } = read;
  const action: Action =
    disk === null
      ? "create"
      : JSON.stringify(value) === JSON.stringify(current)
        ? "keep"
        : "update";
  return { step: { path, action, why }, value };
}

/**
 * A JSON object as it is, or why nodrail can't edit it: a link, as in a
 * dotfiles setup, which writing would replace; or not a JSON object.
 */
function readJson(root: string, path: string) {
  if (folderHost(root).real(path) !== path)
    return "the path goes through a link";
  let disk: Buffer;
  try {
    disk = readFileSync(join(root, path));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR")
      return { disk: null, current: {} as Record<string, unknown> };
    if (code === "EISDIR") return "it isn't a JSON object";
    throw error;
  }
  try {
    const parsed: unknown = JSON.parse(disk.toString("utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("not an object");
    return { disk, current: parsed as Record<string, unknown> };
  } catch {
    return "it isn't a JSON object";
  }
}

/** Why settings that read fine still can't take nodrail's entries, or null. */
function settingsRefusal(
  current: Record<string, unknown>,
  ours: HostState["settings"] | undefined,
  want: DesiredSettings,
) {
  if (
    current.agent !== undefined &&
    current.agent !== want.agent &&
    current.agent !== ours?.agent
  )
    return `agent is set to ${JSON.stringify(current.agent)}, not by nodrail`;
  if (current.disableAllHooks === true)
    return "disableAllHooks is on, so no hook would run";
  return null;
}

const isOurs = (hook: unknown) =>
  typeof hook === "object" &&
  hook !== null &&
  isNodrailHook((hook as { command?: unknown }).command);

/**
 * The hook groups with nodrail's own hooks taken out, and a group left empty
 * by that dropped. Everyone else's hooks stay where they were.
 */
function withoutOurs(groups: unknown[]) {
  return groups.flatMap((group) => {
    const inner = (group as { hooks?: unknown }).hooks;
    if (!Array.isArray(inner) || !inner.some(isOurs)) return [group];
    const rest = inner.filter((hook) => !isOurs(hook));
    return rest.length > 0 ? [{ ...(group as object), hooks: rest }] : [];
  });
}

/** A shared file with nodrail's entries out: rewritten, or removed if empty. */
export type UndoStep = {
  path: string;
  action: "update" | "remove" | "keep" | "conflict";
  why: string;
  value: Record<string, unknown> | null;
};

/**
 * Claude Code's shared files with every entry nodrail set taken out: the
 * agent it set, its hook, the connections and plugins it switched on, its
 * `.mcp.json` servers. Everyone else's stay. A file left with nothing in it
 * held only nodrail's entries, and is removed.
 */
export function claudeUndoSteps(
  root: string,
  ours: HostState["settings"] | undefined,
): UndoStep[] {
  const steps: UndoStep[] = [];
  const settings = undoIn(
    root,
    SETTINGS_FILE,
    "the agent, the policy hook and what nodrail switched on",
    (value) => {
      if (ours?.agent !== undefined && value.agent === ours.agent)
        delete value.agent;
      undoHooks(value);
      undoEnabled(value, ours);
    },
  );
  if (settings) steps.push(settings);
  const servers = ours?.mcpServers ?? [];
  if (servers.length > 0) {
    const mcp = undoIn(
      root,
      MCP_FILE,
      `the connections ${servers.join(", ")}`,
      (value) => {
        const kept = {
          ...((value.mcpServers ?? {}) as Record<string, unknown>),
        };
        for (const name of servers) delete kept[name];
        if (Object.keys(kept).length > 0) value.mcpServers = kept;
        else delete value.mcpServers;
      },
    );
    if (mcp) steps.push(mcp);
  }
  return steps;
}

/** Settings' hooks with nodrail's out, and what that leaves empty. */
function undoHooks(value: Record<string, unknown>) {
  const hooks = value.hooks;
  if (hooks === null || typeof hooks !== "object" || Array.isArray(hooks))
    return;
  const rest = { ...(hooks as Record<string, unknown>) };
  for (const event of ["PreToolUse", "SessionStart", ...STEP_EVENTS]) {
    const groups = Array.isArray(rest[event])
      ? withoutOurs(rest[event] as unknown[])
      : null;
    if (groups?.length === 0) delete rest[event];
    else if (groups) rest[event] = groups;
  }
  if (Object.keys(rest).length > 0) value.hooks = rest;
  else delete value.hooks;
}

/** The servers, marketplaces and plugins nodrail switched on, switched off. */
function undoEnabled(
  value: Record<string, unknown>,
  ours: HostState["settings"] | undefined,
) {
  if (Array.isArray(value.enabledMcpjsonServers)) {
    const kept = mergedNames(
      value.enabledMcpjsonServers,
      ours?.mcpServers ?? [],
      [],
    );
    if (kept.length > 0) value.enabledMcpjsonServers = kept;
    else delete value.enabledMcpjsonServers;
  }
  for (const [key, names] of [
    ["extraKnownMarketplaces", ours?.marketplaces ?? []],
    ["enabledPlugins", ours?.plugins ?? []],
  ] as const) {
    mergeEntries(value, key, names, {});
    const left = value[key];
    if (
      left !== null &&
      typeof left === "object" &&
      Object.keys(left).length === 0
    )
      delete value[key];
  }
}

/** One shared file with `take` applied, or null when it isn't there. */
function undoIn(
  root: string,
  path: string,
  why: string,
  take: (value: Record<string, unknown>) => void,
): UndoStep | null {
  const read = readJson(root, path);
  if (typeof read === "string")
    return { path, action: "conflict", why: `${why}; ${read}`, value: null };
  if (read.disk === null) return null;
  const value = structuredClone(read.current);
  take(value);
  if (Object.keys(value).length === 0)
    return { path, action: "remove", why, value: null };
  return JSON.stringify(value) === JSON.stringify(read.current)
    ? { path, action: "keep", why: "nothing of nodrail's left", value: null }
    : { path, action: "update", why, value };
}
