import type { SetupPlan } from "./plan.ts";

type Changes = NonNullable<SetupPlan["remoteChanges"]>;

function itemsFor(
  changes: Changes,
  action: "added" | "changed" | "removed",
  mark: string,
) {
  const names = changes.agent_changes?.[action];
  const combined = changes[action];
  const count = changes.policy_counts?.[action];
  return {
    rules:
      names && count !== undefined
        ? combined.slice(combined.length - count)
        : combined.filter((item) => !item.startsWith("agent ")),
    names:
      names?.map((name) => `  ${mark} agent ${name}`) ??
      combined
        .filter((item) => item.startsWith("agent "))
        .map((item) => `  ${mark} ${item}`),
  };
}

function groupedChanges(changes: Changes, catalogRules: ReadonlySet<string>) {
  const groups = [
    { mark: "+", action: "added" },
    { mark: "~", action: "changed" },
    { mark: "-", action: "removed" },
  ] as const;
  const catalog: string[] = [];
  const project: string[] = [];
  const agents: string[] = [];
  const removed = [...(changes.catalog_removed ?? [])];
  for (const { mark, action } of groups) {
    const { names, rules } = itemsFor(changes, action, mark);
    agents.push(...names);
    for (const item of rules) {
      const index = action === "removed" ? removed.indexOf(item) : -1;
      const fromCatalog =
        action === "removed" ? index >= 0 : catalogRules.has(item);
      if (index >= 0) removed.splice(index, 1);
      const lines = fromCatalog ? catalog : project;
      lines.push(`  ${mark} ${item}`);
    }
  }
  return { agents, project, catalog };
}

function takeoverLines(takeover: Changes["takeover"], details: boolean) {
  if (!takeover) return [];
  return [
    `  Previous policy owner: project ${takeover.project_id}`,
    `  Affected enrolled hosts (${takeover.hosts.length}):`,
    ...(details || takeover.hosts.length <= 10
      ? takeover.hosts.map(({ name, id }) => `    ${name} (${id})`)
      : ["    Use --details to see each host."]),
  ];
}

export function remotePlanLines(plan: SetupPlan, details: boolean) {
  const changes = plan.remoteChanges;
  if (!changes) return [];
  const { agents, project, catalog } = groupedChanges(
    changes,
    plan.catalogRules,
  );
  return [
    "",
    "Control plane changes",
    ...agents,
    ...(details || project.length <= 10
      ? project
      : [`  ${project.length} project rule changes. Use --details to expand.`]),
    ...(details
      ? catalog
      : catalog.length
        ? [`  ${catalog.length} catalog rule changes. Use --details to expand.`]
        : []),
    ...takeoverLines(changes.takeover, details),
  ];
}
