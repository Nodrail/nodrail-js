import { HOST_NAMES } from "../setup/state.ts";
import { spawnSync } from "node:child_process";
import { relative, resolve } from "node:path";
import type { Command } from "../context.ts";
import { CliError, UsageError } from "../io.ts";
import { holdProject, writeInProgress } from "../project/store.ts";
import { applySetup } from "../setup/apply.ts";
import { EFFECTIVE_FILE, SETTINGS_FILE } from "../setup/claude-code.ts";
import { codexActivation } from "../setup/codex.ts";
import { copilotActivation } from "../setup/copilot.ts";
import {
  connectionLine,
  secretChecks,
  startChecks,
} from "../setup/connections.ts";
import {
  findOnPath,
  isReady,
  planSetup,
  type Check,
  type SetupPlan,
  type StepAction,
} from "../setup/plan.ts";
import {
  claudeActivation,
  enforced,
  type Activation,
} from "../setup/status.ts";
import { budgetText, evidenceText } from "../setup/accountable.ts";
import { credentialChecks } from "../setup/connect.ts";
import {
  livePolicy,
  publishPolicy,
  type Publication,
} from "../setup/connect-policy.ts";
import { verifierChecks } from "../setup/verifiers.ts";

/** ✓ passed, ! blocks, ? passes but wasn't proven here. */
const mark = (check: Check) => (!check.ok ? "!" : check.unverified ? "?" : "✓");

const MARKS: Record<StepAction, string> = {
  create: "+",
  update: "~",
  keep: "=",
  remove: "-",
  conflict: "!",
};

/**
 * The project folder (the one given, else this one), the host `--runtime`
 * picks, and how to name both again in a message.
 */
function target(command: Command, name: "plan" | "apply") {
  const { io, values } = command;
  if (command.args.length > 1)
    throw new UsageError(
      `Usage: nodrail ${name} [<project folder>] [--runtime claude-code|codex|copilot]`,
    );
  const folder = command.args[0];
  const root = folder === undefined ? io.cwd : resolve(io.cwd, folder);
  const runtime = values.runtime;
  const named = relative(io.cwd, root);
  const words = [
    ...(named === "" ? [] : [named.startsWith(".") ? named : `./${named}`]),
    ...(runtime === undefined ? [] : [`--runtime ${runtime}`]),
  ];
  const again = (verb: string) =>
    `\`${["nodrail", verb, ...words].join(" ")}\``;
  return { root, runtime, again };
}

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

/** The plan for a person: checks, then each file and what apply would do. */
export function planText(
  plan: SetupPlan,
  { footer = true, apply = "`nodrail apply`" } = {},
) {
  const width = Math.max(0, ...plan.steps.map((step) => step.path.length));
  const lines = [
    `Plan for ${HOST_NAMES[plan.runtime]}: team ${plan.team}, starting as ${plan.entry}`,
    ...revisionLine(plan),
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
  const changes = changesIn(plan);
  if (footer)
    lines.push(
      "",
      isReady(plan)
        ? changes === 0
          ? "Nothing to change. Nothing was changed."
          : `${changes} change${changes === 1 ? "" : "s"}. Nothing was changed; ${apply} makes them.`
        : "Nothing was changed. Fix what is marked ! first.",
    );
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

/**
 * `nodrail plan`: what `nodrail apply` would set up here, by reading only.
 * Exits 1 when apply couldn't go ahead, so a script can tell.
 */
export async function plan(command: Command) {
  const { io, values } = command;
  const { root, runtime, again } = target(command, "plan");
  const result = planSetup({ root, home: io.home, env: io.env, runtime });
  result.checks.push(...secretChecks(result, io.env));
  result.checks.push(...(await verifierChecks(command, result)));
  result.checks.push(...(await credentialChecks(result, io.env, io.fetch)));
  const live = await livePolicy(result, io, {
    replaceLive: values["replace-live"] === true,
  });
  result.checks.push(...live.checks);
  const active = await activation(result, root, io);
  command.print(
    {
      runtime: result.runtime,
      team: result.team,
      entry: result.entry,
      ready: isReady(result),
      active: legacyActive(result, active),
      activation: active,
      revision: result.revision,
      applied: appliedRevisions(result),
      checks: result.checks,
      connections: result.connections.map(connectionLine),
      steps: result.steps,
      problems: result.problems,
      notes: result.notes,
      ...(result.accountable.budgets.length ||
      result.accountable.evidence.length
        ? {
            accountable: {
              budgets: result.accountable.budgets,
              evidence: result.accountable.evidence,
            },
          }
        : {}),
    },
    () =>
      [
        planText(result, { apply: again("apply") }),
        "",
        `Policy hook: ${active.state}, ${active.detail}.`,
        ...(result.runtime === "codex" && active.state !== "verified"
          ? [`Codex won't run the policy yet: ${active.detail}.`]
          : []),
      ].join("\n"),
  );
  if (!isReady(result))
    throw new CliError("The plan can't be applied yet: see what is marked !.");
  // Opt-in, so plan's exit keeps meaning "apply could go ahead".
  if (values["require-active"] && !enforced(active))
    throw new CliError(
      `The policy isn't enforced here yet (${active.state}): ${active.detail}.`,
    );
}

/** `active` as plan always gave it: Codex's answer, null for Claude Code. */
const legacyActive = (plan: SetupPlan, active: Activation) =>
  plan.runtime === "codex" ? active.state === "verified" : null;

/** The revision each host here was last applied from. */
const appliedRevisions = (plan: SetupPlan) =>
  Object.fromEntries(
    Object.entries(plan.state?.hosts ?? {}).map(([host, entry]) => [
      host,
      entry?.revision ?? null,
    ]),
  );

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
  const { io, values } = command;
  const { root, runtime, again } = target(command, "apply");
  if (values.json && !values.yes)
    throw new UsageError("`nodrail apply --json` needs --yes: it can't ask.");
  const place = { root, home: io.home, env: io.env, runtime };
  // A write that stopped partway is finished (or another nodrail at work is
  // named) before planning, so the plan shown is of a whole project.
  if (writeInProgress(place)) holdProject(place, () => undefined);
  const reviewed = planSetup(place);
  reviewed.checks.push(...secretChecks(reviewed, io.env));
  reviewed.checks.push(...(await credentialChecks(reviewed, io.env, io.fetch)));
  const policy = await livePolicy(reviewed, io, {
    replaceLive: values["replace-live"] === true,
    required: true,
  });
  reviewed.checks.push(...policy.checks);
  if (!values.json) io.out(planText(reviewed, { footer: false }));
  if (!isReady(reviewed))
    throw new CliError(
      `Nothing was changed. Fix what is marked ! first, then run ${again("apply")} again.`,
    );
  const count = changesIn(reviewed) + (policy.publish ? 1 : 0);
  if (!(await confirmed(command, count))) {
    io.out("Nothing was changed.");
    return;
  }
  // Accepted: now, and only now, each connection may start, to show it
  // offers what it declares. One that doesn't stops apply before any write.
  if (count > 0) await connectionsStart(command, reviewed, root);
  // Published before any file is written, so a hook that asks Nodrail
  // never runs against the rules this apply replaces.
  if (policy.publish) await published(command, policy.publish);
  // Even with nothing to change: the state records what nodrail owns.
  applySetup(place, reviewed, again("apply"));
  await finish(command, reviewed, count, { root, again });
}

/** Publishes the locked policy plan showed; a change made since is refused. */
async function published(command: Command, publication: Publication) {
  const result = await publishPolicy(publication);
  command.say(
    `Published lock ${publication.managed.revision.slice(0, 12)} to ${publication.api.url}: policy v${result.policy_revision} (${result.added} added, ${result.changed} changed, ${result.removed} removed).`,
  );
}

/** Starts each connection once after the plan was accepted, and checks it. */
async function connectionsStart(
  command: Command,
  reviewed: SetupPlan,
  root: string,
) {
  const { io, values } = command;
  if (reviewed.connections.length === 0) return;
  const checks = await startChecks({ root, setup: reviewed, env: io.env });
  if (!values.json)
    io.out(
      [
        "",
        "Connections, started once to list their tools",
        ...checks.map(
          (check) => `  ${mark(check)} ${check.name}: ${check.detail}`,
        ),
      ].join("\n"),
    );
  const failed = checks.filter((check) => !check.ok);
  if (failed.length > 0)
    throw new CliError(
      `Nothing was changed: ${failed.map((check) => `${check.name} ${check.detail}`).join("; ")}.`,
    );
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
async function finish(
  command: Command,
  reviewed: SetupPlan,
  count: number,
  { root, again }: { root: string; again: (verb: string) => string },
) {
  const { io, values } = command;
  const done = count > 0 ? `Applied ${plural(count)}.` : "Nothing to change.";
  const active = await activation(reviewed, root, io, { applied: true });
  if (reviewed.runtime === "codex" && active.state !== "verified") {
    if (!values.json) io.out(`\n${done}`);
    // The files are right, but Codex would run without the policy: not ready.
    throw new CliError(
      `Codex won't run the policy yet: ${active.detail}. Then run ${again("plan")} to check.`,
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
      active: legacyActive(reviewed, active),
      activation: active,
      restart,
    },
    () =>
      [
        "",
        done,
        ...(restart
          ? [
              `A ${HOST_NAMES[reviewed.runtime]} session already open here keeps the agents, skills and settings it started with: start a new one to use these.`,
            ]
          : []),
        ...(policy
          ? [
              "The policy applies to open sessions too, from their next tool call.",
            ]
          : []),
        `Run \`${[program, ...startArgs(reviewed)].join(" ")}\` in ${root === io.cwd ? "this folder" : root}: it starts as ${reviewed.entry}, behind the policy hook.`,
      ].join("\n"),
  );
  if (reviewed.start && io.interactive && !values.json)
    start([program, ...startArgs(reviewed)], root, io);
}

const PROGRAMS = {
  "claude-code": "claude",
  codex: "codex",
  copilot: "copilot",
} as const;

/** What starts the host as the entry agent: Copilot takes it on its command line. */
const startArgs = (plan: SetupPlan) =>
  plan.runtime === "copilot" ? ["--agent", plan.entry] : [];

/**
 * Whether the host runs nodrail's hook here. Codex is asked: it runs a
 * project's hooks only once the person trusts the folder and the hook.
 * Claude Code can't be asked; its settings are read for what turns hooks off.
 */
async function activation(
  plan: SetupPlan,
  root: string,
  io: Command["io"],
  { applied = false } = {},
): Promise<Activation> {
  if (plan.runtime === "claude-code") {
    const pending = plan.steps.some(
      (step) =>
        (step.path === SETTINGS_FILE || step.path === EFFECTIVE_FILE) &&
        step.action !== "keep",
    );
    if (pending && !applied)
      return {
        state: "inactive",
        detail: "apply hasn't written the hook and the policy yet",
      };
    return claudeActivation({ root, home: io.home, env: io.env });
  }
  if (plan.runtime === "copilot")
    return copilotActivation({ root, home: io.home, env: io.env });
  const codex = findOnPath("codex", io.env);
  if (codex === null)
    return { state: "unknown", detail: "codex isn't on PATH to ask" };
  return codexActivation({
    root,
    codex,
    env: io.env,
    entry: plan.entry,
    setup: plan,
    effective: plan.files
      .find((file) => file.path === EFFECTIVE_FILE)
      ?.content.toString("utf8"),
  });
}

/** Opens the host here, as the person would; its settings pick the agent. */
function start([program, ...args]: string[], root: string, io: Command["io"]) {
  const path = findOnPath(program!, io.env);
  if (path === null) throw new CliError(`${program} isn't on PATH.`);
  const windows = process.platform === "win32";
  spawnSync(windows ? `"${path}"` : path, args, {
    cwd: root,
    env: io.env as NodeJS.ProcessEnv,
    stdio: "inherit",
    shell: windows,
  });
}
