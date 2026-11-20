import type { Runtime } from "./state.ts";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { ProjectSetup } from "@nodrail/policy-engine/yaml";
import type { DesiredSettings } from "./claude-code.ts";
import { marketplaceName } from "./plugins.ts";

/**
 * What an administrator's settings say about what nodrail sets up. Claude
 * Code and Codex let an organization switch off hooks, MCP servers, plugins
 * and marketplaces on a machine, whatever a project asks; the project's
 * setup then doesn't load, quietly. `plan` reads the files it can and says
 * so before apply. A remote or MDM-delivered policy isn't a file nodrail can
 * read: it is named when its trace is there, and otherwise not known.
 */

type Check = {
  name: string;
  ok: boolean;
  detail: string;
  unverified?: boolean;
};
type Json = Record<string, unknown>;

/** Where each host keeps an administrator's files, by platform. */
export const MANAGED_FOLDERS: Partial<
  Record<NodeJS.Platform, { claude: string; codex: string }>
> = {
  darwin: {
    claude: "/Library/Application Support/ClaudeCode",
    codex: "/etc/codex",
  },
  linux: { claude: "/etc/claude-code", codex: "/etc/codex" },
  win32: {
    claude: "C:\\Program Files\\ClaudeCode",
    codex: "C:\\ProgramData\\OpenAI\\Codex",
  },
};

/**
 * macOS configuration profiles, for the machine or this user, which outrank
 * the files and aren't read here.
 */
const profileOf = (domain: string) => {
  if (process.platform !== "darwin") return undefined;
  const places = [`/Library/Managed Preferences/${domain}.plist`];
  if (process.env.USER)
    places.push(
      `/Library/Managed Preferences/${process.env.USER}/${domain}.plist`,
    );
  return places.find((place) => existsSync(place));
};
const PROFILES = {
  claude: "com.anthropic.claudecode",
  codex: "com.openai.codex",
};

const object = (value: unknown): Json | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : null;

function jsonAt(path: string): Json | null {
  try {
    return object(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

/**
 * Claude Code's managed settings from files: managed-settings.json, then
 * each managed-settings.d/*.json in name order. A later value replaces an
 * earlier one, lists are joined, objects merge key by key. Null when there
 * is none.
 */
export function claudeManaged(folder: string | undefined): Json | null {
  if (folder === undefined) return null;
  const drop = join(folder, "managed-settings.d");
  let names: string[] = [];
  try {
    names = readdirSync(drop)
      .filter((name) => name.endsWith(".json") && !name.startsWith("."))
      .sort();
  } catch {
    names = [];
  }
  const parts = [
    jsonAt(join(folder, "managed-settings.json")),
    ...names.map((name) => jsonAt(join(drop, name))),
  ];
  const found = parts.filter((part): part is Json => part !== null);
  if (found.length === 0) return null;
  const merged: Json = {};
  for (const part of found)
    for (const [key, value] of Object.entries(part)) {
      const had = merged[key];
      if (Array.isArray(had) && Array.isArray(value))
        merged[key] = [...had, ...value];
      else if (object(had) && object(value))
        merged[key] = { ...object(had), ...object(value) };
      else merged[key] = value;
    }
  return merged;
}

/** Which surfaces `strictPluginOnlyCustomization` keeps to plugins. */
export function pluginOnly(
  managed: Json | null,
  surface: "hooks" | "agents" | "skills" | "mcp",
) {
  const value = managed?.strictPluginOnlyCustomization;
  return value === true || (Array.isArray(value) && value.includes(surface));
}

type Server = { name: string; command: string[] };

/** Whether a managed MCP entry names this server, by its name or exact command line. */
function names(entry: unknown, server: Server) {
  const each = object(entry);
  if (!each) return false;
  if (typeof each.serverName === "string")
    return each.serverName === server.name;
  if (Array.isArray(each.serverCommand))
    return (
      JSON.stringify(each.serverCommand) === JSON.stringify(server.command)
    );
  return false;
}

/** Why Claude Code won't start one of nodrail's connections, or null. */
function serverRefusal(managed: Json, server: Server, folder: string) {
  const list = (key: string) =>
    Array.isArray(managed[key]) ? (managed[key] as unknown[]) : null;
  if (existsSync(join(folder, "managed-mcp.json")))
    return `${join(folder, "managed-mcp.json")} gives your administrator sole control of MCP servers`;
  if (pluginOnly(managed, "mcp"))
    return "managed strictPluginOnlyCustomization keeps MCP servers to plugins";
  if (list("deniedMcpServers")?.some((entry) => names(entry, server)))
    return "managed deniedMcpServers names it";
  if ((list("disabledMcpjsonServers") ?? []).includes(server.name))
    return "managed disabledMcpjsonServers names it";
  const allowed = list("allowedMcpServers");
  if (allowed && !allowed.some((entry) => names(entry, server)))
    return "managed allowedMcpServers doesn't name it";
  return null;
}

/** Whether a managed marketplace entry names this folder. */
function namesFolder(entry: unknown, root: string) {
  const each = object(entry);
  if (!each) return false;
  if (each.source === "directory") return each.path === root;
  if (each.source === "pathPattern" && typeof each.pathPattern === "string")
    try {
      return new RegExp(each.pathPattern).test(root);
    } catch {
      return false;
    }
  return false;
}

/** Why Claude Code won't load the project's plugins, or null. */
function marketplaceRefusal(managed: Json, root: string) {
  const blocked = managed.blockedMarketplaces;
  if (
    Array.isArray(blocked) &&
    blocked.some((entry) => namesFolder(entry, root))
  )
    return "managed blockedMarketplaces names this folder";
  const allowed =
    managed.strictKnownMarketplaces ?? managed.allowedMarketplaces;
  if (
    Array.isArray(allowed) &&
    !allowed.some((entry) => namesFolder(entry, root))
  )
    return "managed strictKnownMarketplaces doesn't allow a marketplace in this folder";
  return null;
}

const blocked = (name: string, why: string, remedy: string): Check => ({
  name,
  ok: false,
  detail: `${why}, so Claude Code won't load it. ${remedy}`,
});

const ASK = "Ask your administrator, or take it out of nodrail.yaml";

/**
 * Claude Code's checks against an administrator's settings: each connection,
 * the plugins, the agents and skills, and the agent the session starts as.
 * A file-based policy it can read; a configuration profile it names.
 */
export function claudeManagedChecks(input: {
  root: string;
  setup: Pick<ProjectSetup, "plugins">;
  settings: DesiredSettings;
  folder?: string;
  profile?: string;
}): Check[] {
  const folder = input.folder ?? MANAGED_FOLDERS[process.platform]?.claude;
  const profile = input.profile ?? profileOf(PROFILES.claude);
  const checks: Check[] =
    profile && existsSync(profile) ? [unread("managed settings", profile)] : [];
  const exclusive =
    folder !== undefined && existsSync(join(folder, "managed-mcp.json"));
  const managed = claudeManaged(folder) ?? (exclusive ? {} : null);
  if (managed === null || folder === undefined) return checks;
  return [
    ...checks,
    ...serverChecks(managed, input.settings, folder),
    ...pluginChecks(managed, input),
    ...surfaceChecks(managed, input.settings),
  ];
}

const unread = (name: string, profile: string): Check => ({
  name,
  ok: true,
  unverified: true,
  detail: `${profile} is an administrator's profile, which nodrail doesn't read; it may turn off what apply sets up`,
});

function serverChecks(
  managed: Json,
  settings: DesiredSettings,
  folder: string,
) {
  return Object.entries(settings.mcpServers).flatMap(([name, entry]) => {
    const server = entry as { command: string; args: string[] };
    const why = serverRefusal(
      managed,
      { name, command: [server.command, ...server.args] },
      folder,
    );
    return why ? [blocked(`connection ${name}`, why, ASK)] : [];
  });
}

function pluginChecks(
  managed: Json,
  input: {
    root: string;
    setup: Pick<ProjectSetup, "plugins">;
    settings: DesiredSettings;
  },
) {
  const enabled = Object.keys(input.settings.plugins.enabled);
  if (enabled.length === 0) return [];
  const why = marketplaceRefusal(managed, realpathSync(input.root));
  const forced = object(managed.enabledPlugins) ?? {};
  return [
    ...(why
      ? [
          blocked(
            `marketplace ${marketplaceName(input.setup as ProjectSetup)}`,
            why,
            ASK,
          ),
        ]
      : []),
    ...enabled
      .filter((key) => forced[key] === false)
      .map((key) =>
        blocked(`plugin ${key}`, "managed enabledPlugins turns it off", ASK),
      ),
  ];
}

function surfaceChecks(managed: Json, settings: DesiredSettings) {
  const checks = (["agents", "skills"] as const)
    .filter((surface) => pluginOnly(managed, surface))
    .map((surface) =>
      blocked(
        `project ${surface}`,
        `managed strictPluginOnlyCustomization keeps ${surface} to plugins`,
        "Ask your administrator",
      ),
    );
  if (typeof managed.agent === "string" && managed.agent !== settings.agent)
    checks.push(
      blocked(
        "agent",
        `managed settings start every session as ${managed.agent}, not ${settings.agent}`,
        "Ask your administrator",
      ),
    );
  return checks;
}

/** What an administrator's settings turn off of the setup, on this host. */
export function managedChecks(
  runtime: Runtime,
  input: {
    root: string;
    setup: ProjectSetup;
    settings: DesiredSettings | null;
    managed?: { claude?: string; codex?: string; profile?: string };
  },
) {
  const { managed } = input;
  // Copilot's are read with its hooks (copilotHookChecks).
  if (runtime === "copilot") return [];
  if (runtime === "codex")
    return codexManagedChecks({
      setup: input.setup,
      folder: managed?.codex,
      profile: managed?.profile,
    });
  return input.settings
    ? claudeManagedChecks({
        ...input,
        settings: input.settings,
        folder: managed?.claude,
        profile: managed?.profile,
      })
    : [];
}

/**
 * Codex's requirements, as far as plan can tell without a TOML reader or
 * the documented semantics in full: what they may turn off is marked `?`.
 * Whether Codex runs nodrail's hook is asked of Codex itself.
 */
export function codexManagedChecks(input: {
  setup: Pick<ProjectSetup, "connections" | "plugins">;
  folder?: string;
  profile?: string;
}): Check[] {
  const folder = input.folder ?? MANAGED_FOLDERS[process.platform]?.codex;
  const checks: Check[] = [];
  const profile = input.profile ?? profileOf(PROFILES.codex);
  if (profile && existsSync(profile))
    checks.push(unread("managed requirements", profile));
  if (folder === undefined) return checks;
  let text: string;
  try {
    text = readFileSync(join(folder, "requirements.toml"), "utf8");
  } catch {
    return checks;
  }
  const file = join(folder, "requirements.toml");
  const tables = [...text.matchAll(/^[ \t]*\[([^\]]+)\]/gm)].map((match) =>
    match[1]!.trim(),
  );
  const maybe = (name: string, why: string) =>
    checks.push({
      name,
      ok: true,
      unverified: true,
      detail: `${file} ${why}; Codex may not load it`,
    });
  const servers = tables.filter((table) => /^mcp_servers(\.|$)/.test(table));
  if (servers.length > 0)
    for (const { name } of input.setup.connections)
      if (
        !servers.some(
          (table) =>
            table === `mcp_servers.${name}` ||
            table === `mcp_servers."${name}"`,
        )
      )
        maybe(`connection ${name}`, "lists MCP servers and not this one");
  if (input.setup.plugins.length > 0) {
    if (/^\s*plugins\s*=\s*false/m.test(sectionOf(text, "features")))
      maybe("plugins", "turns plugins off ([features] plugins = false)");
    if (
      /^\s*restrict_to_allowed_sources\s*=\s*true/m.test(
        sectionOf(text, "marketplaces"),
      )
    )
      maybe("plugins", "restricts marketplaces to allowed sources");
  }
  return checks;
}

/** A TOML table's own lines, up to the next table. */
function sectionOf(text: string, table: string) {
  const start = text.search(new RegExp(`^[ \\t]*\\[${table}\\][ \\t]*$`, "m"));
  if (start < 0) return "";
  const rest = text.slice(start).split("\n").slice(1);
  const end = rest.findIndex((line) => /^\s*\[/.test(line));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}
