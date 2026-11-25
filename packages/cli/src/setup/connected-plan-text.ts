import { connectUrl } from "./connect.ts";
import { isReady, type SetupPlan } from "./plan.ts";
import { remotePlanLines } from "./remote-plan-text.ts";

export const setupChangeCount = (plan: SetupPlan) =>
  plan.steps.filter(({ action }) => action !== "keep" && action !== "conflict")
    .length;

export const setupChangesLabel = (count: number) =>
  `${count} setup change${count === 1 ? "" : "s"} on this machine`;

export function connectedPlanHeading(plan: SetupPlan, project: string) {
  const { connect } = plan;
  return connect?.decide === "cloud"
    ? `Plan for project ${project} (${plan.runtime}) · ${connect.workspace}/${connect.environment} at ${connectUrl(connect)}`
    : null;
}

export function connectedPlanText(
  plan: SetupPlan,
  options: {
    project: string;
    footer: boolean;
    apply: string;
    publishes: boolean;
  },
) {
  const { connect, checks, problems, steps } = plan;
  const files = setupChangeCount(plan);
  const live = checks.filter(
    ({ name, ok }) =>
      !ok ||
      ["live policy", "machine enrollment", "intended revision"].includes(name),
  );
  const ready = isReady(plan);
  const next = !ready
    ? "Nothing was changed. Fix what is marked ! first."
    : files || options.publishes
      ? `Nothing was changed. ${options.apply} makes these changes.`
      : "Nothing to change. Nothing was changed.";
  return [
    connectedPlanHeading(plan, options.project),
    ...live.map(({ ok, detail }) => `  ${ok ? "✓" : "!"} ${detail}`),
    ...remotePlanLines(plan, false),
    `Setup: ${setupChangesLabel(files)}${connect?.enforce === "watch" ? " (watch mode)" : ""}.`,
    ...(plan.connections.length
      ? [`Tool connections to check on apply: ${plan.connections.length}.`]
      : []),
    ...steps
      .filter(({ action }) => action === "conflict")
      .map(({ path, why }) => `  ! ${path}: ${why}`),
    ...problems.map((problem) => `  ! ${problem}`),
    ...(options.footer ? [next, "Use --details for the full plan."] : []),
  ].join("\n");
}
