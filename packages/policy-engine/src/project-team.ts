import { stringify } from "yaml";
import { CODEX_COLLABORATION } from "./codex-actions.ts";
import { exposureOf, type AgentConnections } from "./connections.ts";
import { agentName } from "./names.ts";
import { pluginsOf, type AgentPlugins } from "./plugins.ts";
import type {
  SetupAgent,
  SetupConnection,
  SetupPlugin,
  SetupTeam,
} from "./project-resources.ts";

/**
 * Where a host reads who an agent is and what it may do: its agent
 * definitions, skills, hooks and settings, and Nodrail's own project files.
 * An agent that could write one could make itself another agent.
 */
export const SETUP_PLACES = [
  ".claude",
  ".claude-plugin",
  ".codex",
  ".agents",
  ".nodrail",
  "nodrail.yaml",
  "nodrail.lock.yaml",
] as const;

/**
 * Copilot's places, inside `.github`, which the rest of a project may be in
 * (workflows are an agent's work): the hook's guard keeps agents from them
 * by path, whatever the rules say. `.github/copilot` holds settings that
 * can switch every hook off.
 */
export const COPILOT_PLACES = [
  ".github/agents",
  ".github/hooks",
  ".github/skills",
  ".github/mcp.json",
  ".github/copilot",
] as const;

const FILE_CHANGES = ["file.write", "file.edit", "file.patch", "file.delete"];

/** How each host's hook names starting an agent. */
const HOSTS = [
  { tool: "claude-code", suffix: "" },
  { tool: "codex", suffix: " on Codex" },
] as const;

/**
 * The rules a Team means, as an APF file:
 * - each member may start exactly the members it hands off to, and no other
 *   member, itself included, on Claude Code and on Codex. A host's own
 *   agents and others not on the team are left to the rest of the policy,
 *   which blocks what it doesn't cover. Codex's calls on agents already
 *   started (wait, send input, close…) are allowed.
 * - each member may load, on Claude Code, the skills set up for it and the
 *   skills of the plugins it may use; a plugin it may not use is denied;
 * - no agent may change the setup's places, or run nodrail to change them.
 * Deny wins over allow, so another file can't widen either.
 */
export function teamRules(
  team: SetupTeam,
  reach: {
    connections: readonly SetupConnection[];
    agentConnections: AgentConnections | null;
    agents?: readonly SetupAgent[];
    plugins?: readonly SetupPlugin[];
    agentPlugins?: AgentPlugins | null;
  } = { connections: [], agentConnections: null },
) {
  const list = `${team.name}-setup-places`;
  const items: unknown[] = [
    { required_engine_version: 1 },
    { list, items: [...SETUP_PLACES] },
  ];
  for (const change of FILE_CHANGES)
    items.push({
      rule: `Team ${team.name}: never ${change.replace("file.", "")} the setup`,
      tool: "files",
      operation: change,
      resource: { kind: "file", match: "any" },
      condition: [{ field: "path_parts", op: "contains", list }],
      effect: "deny",
    });
  for (const from of team.members) {
    const targets = new Set(
      team.handoffs
        .filter((handoff) => handoff.from === from)
        .map((handoff) => handoff.to),
    );
    for (const to of team.members)
      for (const host of HOSTS)
        items.push({
          rule: `Team ${team.name}: ${from} ${targets.has(to) ? "may" : "never"} start ${to}${host.suffix}`,
          agent: from,
          tool: host.tool,
          operation: "agent",
          resource: { kind: "agent", match: "exact", value: to },
          effect: targets.has(to) ? "allow" : "deny",
        });
  }
  // Run by an agent, nodrail could lock and apply a setup the agent changed.
  const commands = `${team.name}-nodrail-commands`;
  items.push(
    {
      list: commands,
      items: ["nodrail", "nodrail-policy", "nodrail-claude-hook"],
    },
    {
      rule: `Team ${team.name}: agents never run Nodrail itself`,
      command: { list: commands, match: "prefix" },
      effect: "deny",
    },
  );
  items.push(
    ...exposureRules(team, reach),
    ...skillRules(team, reach.agents ?? []),
    ...pluginRules(team, reach.plugins ?? [], reach.agentPlugins ?? null),
  );
  // Waiting on, messaging or closing an agent already started changes no
  // one's identity, and Codex hands work over that way.
  for (const operation of CODEX_COLLABORATION)
    items.push({
      rule: `Team ${team.name}: agents may ${operation.replace(/_/g, " ")} on Codex`,
      tool: "codex",
      operation,
      resource: { kind: "tool", match: "any" },
      effect: "allow",
    });
  return `# What Team ${team.name} means: who may start whom, which connections
# each agent may use, and the setup kept out of every agent's reach. Written by nodrail from ${team.file}.
${stringify(items, { lineWidth: 0, flowCollectionPadding: false })}`;
}

/**
 * Each member may load the skills its Agent lists: the host was given them
 * for that agent. A skill is named by its folder, as the host knows it.
 */
function skillRules(team: SetupTeam, agents: readonly SetupAgent[]) {
  return agents
    .filter((agent) => team.members.includes(agent.name))
    .flatMap((agent) =>
      agent.skills.map((folder) => {
        const skill = agentName(folder.split("/").pop()!);
        return {
          rule: `Team ${team.name}: ${agent.name} may load skill ${skill}`,
          agent: agent.name,
          tool: "claude-code",
          operation: "skill",
          resource: { kind: "skill", match: "exact", value: skill },
          effect: "allow",
        };
      }),
    );
}

/**
 * Each member may load the skills of the plugins it may use, named
 * `<plugin>:<skill>`; on the servers of any other plugin, every operation
 * is denied, as for a connection it isn't given.
 */
function pluginRules(
  team: SetupTeam,
  plugins: readonly SetupPlugin[],
  agentPlugins: AgentPlugins | null,
) {
  const specs = Object.fromEntries(
    plugins.map((each) => [each.name, each.spec]),
  );
  return team.members.flatMap((agent) => {
    const allowed = pluginsOf(agentPlugins, agent, specs);
    return plugins.flatMap(({ name, spec }) =>
      allowed.has(name)
        ? [
            {
              rule: `Team ${team.name}: ${agent} may load the skills of plugin ${name}`,
              agent,
              tool: "claude-code",
              operation: "skill",
              resource: { kind: "skill", match: "prefix", value: `${name}:` },
              effect: "allow",
            },
          ]
        : Object.entries(spec.servers).flatMap(([server, { operations }]) =>
            Object.entries(operations).map(([operation, { resource }]) => ({
              rule: `Team ${team.name}: ${agent} never uses plugin ${name}'s ${server} ${operation}`,
              agent,
              tool: server,
              operation,
              resource: { kind: resource?.kind ?? "mcp_tool", match: "any" },
              effect: "deny",
            })),
          ),
    );
  });
}

/**
 * With `agentConnections`, each member may call only the connections and
 * operations listed for it: any other is denied. Without it, every member
 * may, and the rest of the policy decides each call.
 */
function exposureRules(
  team: SetupTeam,
  reach: {
    connections: readonly SetupConnection[];
    agentConnections: AgentConnections | null;
  },
) {
  if (reach.agentConnections === null) return [];
  const specs = Object.fromEntries(
    reach.connections.map((each) => [each.name, each.spec]),
  );
  const rules: unknown[] = [];
  for (const agent of team.members) {
    const allowed = exposureOf(reach.agentConnections, agent, specs);
    for (const { name, spec } of reach.connections)
      for (const operation of Object.keys(spec.operations))
        if (!allowed.get(name)?.has(operation))
          rules.push({
            rule: `Team ${team.name}: ${agent} never uses ${name} ${operation}`,
            agent,
            tool: name,
            operation,
            resource: {
              kind: spec.operations[operation]?.resource?.kind ?? "mcp_tool",
              match: "any",
            },
            effect: "deny",
          });
  }
  return rules;
}
