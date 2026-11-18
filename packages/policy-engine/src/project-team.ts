import { stringify } from "yaml";
import { CODEX_COLLABORATION } from "./codex-actions.ts";
import type { SetupTeam } from "./project-resources.ts";

/**
 * Where a host reads who an agent is and what it may do: its agent
 * definitions, skills, hooks and settings, and Nodrail's own project files.
 * An agent that could write one could make itself another agent.
 */
export const SETUP_PLACES = [
  ".claude",
  ".codex",
  ".agents",
  ".nodrail",
  "nodrail.yaml",
  "nodrail.lock.yaml",
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
 * - no agent may change the setup's places, or run nodrail to change them.
 * Deny wins over allow, so another file can't widen either.
 */
export function teamRules(team: SetupTeam) {
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
  return `# What Team ${team.name} means: who may start whom, and the setup kept
# out of every agent's reach. Written by nodrail from ${team.file}.
${stringify(items, { lineWidth: 0, flowCollectionPadding: false })}`;
}
