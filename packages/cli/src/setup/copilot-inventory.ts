import { json } from "./hook-settings.ts";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { Env } from "../config.ts";
import { COPILOT_HOOKS, COPILOT_MCP } from "./copilot.ts";
import {
  definitions,
  hostPlaces,
  userDefinitions,
  type Unmanaged,
} from "./inventory.ts";
import type { HostState } from "./state.ts";

/** Copilot's user folder: COPILOT_HOME, or ~/.copilot. */
const copilotHome = (env: Env, home: string) =>
  env.COPILOT_HOME ?? join(home, ".copilot");

const servers = (file: string) =>
  Object.keys(
    (json(file)?.mcpServers as Record<string, unknown> | undefined) ?? {},
  );

/** Hook events in Copilot's hook files, other than nodrail's own file. */
function hooksIn(folder: string, shown: string, scope: Unmanaged["scope"]) {
  let names: string[] = [];
  try {
    names = readdirSync(folder).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  return names
    .filter((name) => `${shown}/${name}` !== COPILOT_HOOKS)
    .flatMap((name) =>
      Object.keys(
        (json(join(folder, name))?.hooks as Record<string, unknown>) ?? {},
      ).map((event): Unmanaged => ({
        kind: "hook",
        name: `${event} (${name})`,
        scope,
        where: shown,
      })),
    );
}

/**
 * What Copilot loads here that nodrail didn't set up: agents and skills in
 * its folders and Claude Code's, which it also reads; MCP servers; hooks.
 */
export function copilotUnmanaged(input: {
  root: string;
  home: string;
  env: Env;
  entry: HostState | null;
}): Unmanaged[] {
  const { root, entry } = input;
  const user = copilotHome(input.env, input.home);
  const shownUser = input.env.COPILOT_HOME ?? "~/.copilot";
  const { owned, project, ...places } = hostPlaces(root, entry, {
    base: user,
    shown: shownUser,
  });
  // nodrail writes the whole of .github/mcp.json: its servers are ours.
  const ours = (shown: string) => shown === COPILOT_MCP && owned(COPILOT_MCP);
  const mcp = (file: string, shown: string, scope: Unmanaged["scope"]) =>
    (ours(shown) ? [] : servers(file)).map((name): Unmanaged => ({
      kind: "MCP server",
      name,
      scope,
      where: shown,
    }));
  return [
    ...definitions(project, owned, {
      agents: { folder: ".github/agents", ending: ".agent.md" },
      skills: [".github/skills", ".agents/skills", ".claude/skills"],
    }),
    ...definitions(project, owned, {
      agents: { folder: ".claude/agents", ending: ".md" },
      skills: [],
    }),
    ...userDefinitions(places.user),
    ...mcp(join(root, COPILOT_MCP), COPILOT_MCP, "project"),
    ...mcp(join(root, ".mcp.json"), ".mcp.json", "project"),
    ...mcp(
      join(user, "mcp-config.json"),
      `${shownUser}/mcp-config.json`,
      "user",
    ),
    ...hooksIn(join(root, ".github/hooks"), ".github/hooks", "project"),
    ...hooksIn(join(user, "hooks"), `${shownUser}/hooks`, "user"),
  ];
}
