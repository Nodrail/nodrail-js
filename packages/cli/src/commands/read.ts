import type { Query } from "../api.ts";
import type { Command, Values } from "../context.ts";
import { activityTable, runsTable, table } from "../format.ts";
import { noArgs, requireArg } from "./auth.ts";

const filtersOf = (values: Values, names: (keyof Values)[]): Query =>
  Object.fromEntries(
    names
      .filter((name) => values[name] !== undefined)
      .map((name) => [name, String(values[name])]),
  );

const more = (cursor: string | null) =>
  cursor ? `\nMore: --cursor ${cursor}` : "";

export async function activity(command: Command) {
  noArgs(command);
  const page = await (
    await command.api()
  ).activity(
    filtersOf(command.values, [
      "q",
      "agent",
      "outcome",
      "kind",
      "range",
      "run",
      "limit",
      "cursor",
    ]),
  );
  command.print(page, () => activityTable(page.items) + more(page.next_cursor));
}

export async function runs(command: Command) {
  noArgs(command);
  const page = await (
    await command.api()
  ).runs(
    filtersOf(command.values, [
      "q",
      "agent",
      "outcome",
      "range",
      "limit",
      "cursor",
    ]),
  );
  command.print(page, () => runsTable(page.items) + more(page.next_cursor));
}

type TimelineEntry = {
  kind: string;
  at: string;
  step?: { agent: string; step_key: string; verdict: string | null };
  action?: {
    tool_key: string;
    operation_key: string;
    resource: string;
    evaluation: string;
  };
};

function entryText(entry: TimelineEntry) {
  if (entry.action)
    return `${entry.action.tool_key}.${entry.action.operation_key} ${entry.action.resource} · ${entry.action.evaluation}`;
  const step = entry.step;
  if (!step) return "";
  const verdict = step.verdict ? ` · ${step.verdict}` : "";
  return `${step.agent} step ${step.step_key}${entry.kind === "finished" ? verdict : ""}`;
}

export async function run(command: Command) {
  const id = requireArg(command, "the run's ID");
  const found = await (await command.api()).run(id);
  command.print(found, () =>
    [
      `Run ${found.key} (${found.id}) · ${found.status}`,
      `${found.steps} steps, ${found.actions} actions, ${found.held} held, ${found.waiting} waiting`,
      "",
      table(
        (found.timeline as TimelineEntry[]).map((entry) => [
          entry.at,
          entry.kind,
          entryText(entry),
        ]),
      ),
    ].join("\n"),
  );
}

type Insights = {
  days: number;
  approvals: {
    requests: number;
    approved: number;
    denied: number;
    expired: number;
    waiting: number;
    median_seconds_to_decide: number | null;
  };
  repeated_approvals: {
    agent_key: string;
    tool_key: string;
    operation_key: string;
    resource: string;
    approved: number;
  }[];
};

export async function insights(command: Command) {
  noArgs(command);
  const days = command.values.days ? Number(command.values.days) : undefined;
  const data = (await (await command.api()).insights(days)) as Insights;
  command.print(data, () => {
    const a = data.approvals;
    const median =
      a.median_seconds_to_decide === null
        ? "—"
        : `${Math.round(a.median_seconds_to_decide)}s`;
    const repeated = data.repeated_approvals.map(
      (item) =>
        `  ${item.agent_key} ${item.tool_key}.${item.operation_key} ${item.resource} · approved ${item.approved}×`,
    );
    return [
      `Last ${data.days} days`,
      `Requests ${a.requests}: ${a.approved} approved, ${a.denied} denied, ${a.expired} expired, ${a.waiting} waiting. Median time to decide ${median}.`,
      repeated.length
        ? `Approvals that could be a rule:\n${repeated.join("\n")}`
        : "No approvals repeat enough to suggest a rule.",
    ].join("\n");
  });
}
