import { spawnSync } from "node:child_process";
import type { Command } from "../context.ts";
import { CliError, UsageError } from "../io.ts";
import { holdProject, writeInProgress } from "../project/store.ts";
import { applySetup } from "../setup/apply.ts";
import { EFFECTIVE_FILE } from "../setup/claude-code.ts";
import { codexActivation } from "../setup/codex.ts";
import {
  findOnPath,
  isReady,
  planSetup,
  type SetupPlan,
  type StepAction,
} from "../setup/plan.ts";

const HOSTS = { "claude-code": "Claude Code", codex: "Codex" } as const;

const MARKS: Record<StepAction, string> = {
  create: "+",
  update: "~",
  keep: "=",
  remove: "-",
  conflict: "!",
};

/** The plan for a person: checks, then each file and what apply would do. */
export function planText(plan: SetupPlan, { footer = true } = {}) {
  const width = Math.max(0, ...plan.steps.map((step) => step.path.length));
  const lines = [
    `Plan for ${HOSTS[plan.runtime]}: team ${plan.team}, starting as ${plan.entry}`,
    "",
    "Checks",
    ...plan.checks.map(
      (check) => `  ${check.ok ? "✓" : "!"} ${check.name}: ${check.detail}`,
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
  if (plan.problems.length > 0)
    lines.push("", "Problems", ...plan.problems.map((text) => `  ! ${text}`));
  if (plan.notes.length > 0)
    lines.push("", ...plan.notes.map((text) => `  ${text}`));
  const changes = changesIn(plan);
  if (footer)
    lines.push(
      "",
      isReady(plan)
        ? changes === 0
          ? "Nothing to change. Nothing was changed."
          : `${changes} change${changes === 1 ? "" : "s"}. Nothing was changed; \`nodrail apply\` makes them.`
        : "Nothing was changed. Fix what is marked ! first.",
    );
  return lines.join("\n");
}

/**
 * `nodrail plan`: what `nodrail apply` would set up here, by reading only.
 * Exits 1 when apply couldn't go ahead, so a script can tell.
 */
export async function plan(command: Command) {
  if (command.args.length > 0)
    throw new UsageError(
      "`nodrail plan` runs in the project folder and takes no arguments.",
    );
  const { io } = command;
  const result = planSetup({ root: io.cwd, home: io.home, env: io.env });
  const active = await activation(result, io);
  command.print(
    {
      runtime: result.runtime,
      team: result.team,
      entry: result.entry,
      ready: isReady(result),
      active: active?.active ?? null,
      checks: result.checks,
      steps: result.steps,
      problems: result.problems,
      notes: result.notes,
    },
    () =>
      [
        planText(result),
        ...(active && !active.active
          ? ["", `Codex won't run the policy yet: ${active.detail}.`]
          : []),
      ].join("\n"),
  );
  if (!isReady(result))
    throw new CliError("The plan can't be applied yet: see what is marked !.");
}

const changesIn = (plan: SetupPlan) =>
  plan.steps.filter(
    (step) => step.action !== "keep" && step.action !== "conflict",
  ).length;

const plural = (count: number) => `${count} change${count === 1 ? "" : "s"}`;

/**
 * `nodrail apply`: the plan, made. It shows the plan and asks first, unless
 * `--yes`; refuses anything `plan` marks with `!`; and changes only what the
 * plan showed, as the project's only writer.
 */
export async function apply(command: Command) {
  if (command.args.length > 0)
    throw new UsageError(
      "`nodrail apply` runs in the project folder and takes no arguments.",
    );
  const { io, values } = command;
  if (values.json && !values.yes)
    throw new UsageError("`nodrail apply --json` needs --yes: it can't ask.");
  const place = { root: io.cwd, home: io.home, env: io.env };
  // A write that stopped partway is finished (or another nodrail at work is
  // named) before planning, so the plan shown is of a whole project.
  if (writeInProgress(place)) holdProject(place, () => undefined);
  const reviewed = planSetup(place);
  if (!values.json) io.out(planText(reviewed, { footer: false }));
  if (!isReady(reviewed))
    throw new CliError(
      "Nothing was changed. Fix what is marked ! first, then run `nodrail apply` again.",
    );
  const count = changesIn(reviewed);
  if (!(await confirmed(command, count))) {
    io.out("Nothing was changed.");
    return;
  }
  // Even with nothing to change: the state records what nodrail owns.
  applySetup(place, reviewed);
  await finish(command, reviewed, count);
}

/** Whether to go ahead: nothing to change, --yes, or the person says yes. */
async function confirmed({ io, values }: Command, count: number) {
  if (count === 0 || values.yes) return true;
  if (!io.interactive)
    throw new UsageError(
      "`nodrail apply` asks before changing files. Run it at a terminal, or add --yes once you have read `nodrail plan`.",
    );
  const answer = await io.ask(`\nApply ${plural(count)}? [y/N] `);
  return /^y(es)?$/i.test(answer.trim());
}

/** After the files: whether the host runs the policy, and how to start it. */
async function finish(command: Command, reviewed: SetupPlan, count: number) {
  const { io, values } = command;
  const done = count > 0 ? `Applied ${plural(count)}.` : "Nothing to change.";
  const active = await activation(reviewed, io);
  if (active && !active.active) {
    if (!values.json) io.out(`\n${done}`);
    // The files are right, but Codex would run without the policy: not ready.
    throw new CliError(
      `Codex won't run the policy yet: ${active.detail}. Then run \`nodrail plan\` to check.`,
    );
  }
  const program = PROGRAMS[reviewed.runtime];
  const applied = reviewed.steps.filter(
    (step) => step.action !== "keep" && step.action !== "conflict",
  );
  // The hook reads the policy at every call; a session reads the rest once.
  const restart = applied.some((step) => !step.path.startsWith(".nodrail/"));
  const policy = applied.some((step) => step.path === EFFECTIVE_FILE);
  command.print(
    {
      applied,
      start: reviewed.start,
      active: active?.active ?? null,
      restart,
    },
    () =>
      [
        "",
        done,
        ...(restart
          ? [
              `A ${HOSTS[reviewed.runtime]} session already open here keeps the agents, skills and settings it started with: start a new one to use these.`,
            ]
          : []),
        ...(policy
          ? [
              "The policy applies to open sessions too, from their next tool call.",
            ]
          : []),
        `Run \`${program}\` in this folder: it starts as ${reviewed.entry}, behind the policy hook.`,
      ].join("\n"),
  );
  if (reviewed.start && io.interactive && !values.json) start(program, io);
}

const PROGRAMS = { "claude-code": "claude", codex: "codex" } as const;

/**
 * For Codex, whether it runs nodrail's hook here: Codex runs a project's
 * hooks only once the person trusts the folder and the hook. Null for
 * Claude Code, which runs project hooks without that step.
 */
async function activation(plan: SetupPlan, io: Command["io"]) {
  if (plan.runtime !== "codex") return null;
  const codex = findOnPath("codex", io.env);
  if (codex === null) return null;
  return codexActivation({
    root: io.cwd,
    codex,
    env: io.env,
    entry: plan.entry,
  });
}

/** Opens the host here, as the person would; its settings pick the agent. */
function start(program: string, io: Command["io"]) {
  const path = findOnPath(program, io.env);
  if (path === null) throw new CliError(`${program} isn't on PATH.`);
  const windows = process.platform === "win32";
  spawnSync(windows ? `"${path}"` : path, [], {
    cwd: io.cwd,
    env: io.env as NodeJS.ProcessEnv,
    stdio: "inherit",
    shell: windows,
  });
}
