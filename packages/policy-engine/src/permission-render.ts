// Permission changes as plain text for a terminal: agent, then operation, then
// resource, with the changes a reviewer must not miss marked "!".
import { sortChanges, type PermissionChange } from "./permission-changes.ts";

const labels = {
  granted: "granted",
  revoked: "revoked",
  tightened: "tightened",
  loosened: "loosened",
  changed: "changed",
  needs_review: "needs review",
} as const;

const width = Math.max(...Object.values(labels).map((label) => label.length));

function agentHeading({ agent, installation }: PermissionChange) {
  const who = agent === null ? "All agents" : `Agent ${agent}`;
  return installation === null ? who : `${who} on ${installation}`;
}

function changeLines(change: PermissionChange) {
  const mark = change.warning ? "!" : " ";
  const label = labels[change.impact].padEnd(width);
  const head = `      ${mark} ${label}  ${change.entry} ${change.id} "${change.name}": ${change.summary}`;
  const indent = " ".repeat(10 + width);
  return [head, ...change.details.map((detail) => `${indent}${detail}`)];
}

function heading(changes: PermissionChange[]) {
  const flagged = changes.filter(({ warning }) => warning).length;
  const count = `${changes.length} permission change${changes.length === 1 ? "" : "s"}`;
  return flagged
    ? `${count}, ${flagged} marked ! weaken a deny, a gate or a budget.`
    : `${count}.`;
}

/**
 * Groups print once, in the order permissionChanges gives; the changes are
 * sorted again here so any list renders the same on every machine.
 */
export function renderPermissionChanges(changes: PermissionChange[]): string {
  if (!changes.length) return "No permission changes.\n";
  const lines = [heading(changes)];
  let last = { agent: "", operation: "", resource: "" };
  for (const change of sortChanges(changes)) {
    const agent = agentHeading(change);
    const operation = change.operation ?? "Budgets";
    const fresh = agent !== last.agent;
    if (fresh) lines.push("", agent);
    if (fresh || operation !== last.operation) lines.push(`  ${operation}`);
    if (
      fresh ||
      operation !== last.operation ||
      change.resource !== last.resource
    )
      lines.push(`    ${change.resource}`);
    lines.push(...changeLines(change));
    last = { agent, operation, resource: change.resource };
  }
  return `${lines.join("\n")}\n`;
}
