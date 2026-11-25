import { budgetText, evidenceText } from "./accountable.ts";
import { connectionLine } from "./connections.ts";
import {
  connectedPlanHeading,
  connectedPlanText,
  setupChangeCount,
  setupChangesLabel,
} from "./connected-plan-text.ts";
import {
  isReady,
  type Check,
  type SetupPlan,
  type StepAction,
} from "./plan.ts";
import { remotePlanLines } from "./remote-plan-text.ts";
import { HOST_NAMES } from "./state.ts";

/** ✓ passed, ! blocks, ? passes but wasn't proven here. */
export const mark = (check: Check) =>
  !check.ok ? "!" : check.unverified ? "?" : "✓";
const MARKS: Record<StepAction, string> = {
  create: "+",
  update: "~",
  keep: "=",
  remove: "-",
  conflict: "!",
};

/** The reviewed revision the plan sets up, by the lock's digests. */
const revisionLine = ({ revision }: SetupPlan) => {
  const parts = [
    ...(revision.workspace
      ? [`workspace ${revision.workspace.slice(0, 12)}`]
      : []),
    ...(revision.policy ? [`policy ${revision.policy.slice(0, 12)}`] : []),
  ];
  return parts.length > 0 ? [`Revision: ${parts.join(", ")}`] : [];
};

function detailedPlanFooter(plan: SetupPlan, changes: number, apply: string) {
  if (!isReady(plan)) return "Nothing was changed. Fix what is marked ! first.";
  if (changes === 0) return "Nothing to change. Nothing was changed.";
  return `Nothing was changed; ${apply} makes them.`;
}

/** The plan for a person: checks, then each file and what apply would do. */
export function planText(
  plan: SetupPlan,
  {
    footer = true,
    apply = "`nodrail apply`",
    publishes = false,
    details = false,
    project = plan.team,
  } = {},
) {
  const options = { project, footer, apply, publishes };
  return plan.connect?.decide === "cloud" && !details
    ? connectedPlanText(plan, options)
    : detailedPlanText(plan, options);
}

function detailedPlanText(
  plan: SetupPlan,
  {
    project,
    footer,
    apply,
    publishes,
  }: {
    project: string;
    footer: boolean;
    apply: string;
    publishes: boolean;
  },
) {
  const width = Math.max(0, ...plan.steps.map((step) => step.path.length));
  const lines = [
    connectedPlanHeading(plan, project) ??
      `Plan for ${HOST_NAMES[plan.runtime]}: team ${plan.team}, starting as ${plan.entry}`,
    ...revisionLine(plan),
    ...remotePlanLines(plan, true),
    "",
    "Checks",
    ...plan.checks.map(
      (check) => `  ${mark(check)} ${check.name}: ${check.detail}`,
    ),
  ];
  if (plan.steps.length > 0)
    lines.push(
      "",
      "Files",
      ...plan.steps.map(
        (step) =>
          `  ${MARKS[step.action]} ${step.path.padEnd(width)}  ${step.why}`,
      ),
    );
  if (plan.connections.length > 0)
    lines.push(
      "",
      "Connections (not started: apply starts each once to check it, after you accept)",
      ...plan.connections.map((each) => `  ${connectionLine(each)}`),
    );
  lines.push(...accountableLines(plan));
  if (plan.problems.length > 0)
    lines.push("", "Problems", ...plan.problems.map((text) => `  ! ${text}`));
  if (plan.notes.length > 0)
    lines.push("", ...plan.notes.map((text) => `  ${text}`));
  lines.push(`Setup: ${setupChangesLabel(setupChangeCount(plan))}.`);
  const changes = setupChangeCount(plan) + Number(publishes);
  if (footer) lines.push("", detailedPlanFooter(plan, changes, apply));
  return lines.join("\n");
}

/** The numeric budgets and evidence requirements, as this setup enforces them. */
function accountableLines({ accountable }: SetupPlan) {
  const lines: string[] = [];
  if (accountable.budgets.length > 0)
    lines.push(
      "",
      "Budgets (operational limits, not your Nodrail bill)",
      ...accountable.budgets.map((line) => `  ${budgetText(line)}`),
    );
  if (accountable.evidence.length > 0)
    lines.push(
      "",
      "Evidence requirements",
      ...accountable.evidence.map((line) => `  ${evidenceText(line)}`),
    );
  return lines;
}
