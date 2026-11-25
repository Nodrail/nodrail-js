import {
  publishPolicy,
  rememberCurrentEnrollment,
} from "../setup/publish-enrollment.ts";
import { HOST_NAMES } from "../setup/state.ts";
import { basename, relative, resolve } from "node:path";
import type { ProposedProject } from "../project/project.ts";
import type { Command } from "../context.ts";
import { CliError, UsageError } from "../io.ts";
import { holdProject, writeInProgress, type Place } from "../project/store.ts";
import { activation, policyRevisionPending } from "../setup/activation.ts";
import { applySetup } from "../setup/apply.ts";
import { EFFECTIVE_FILE } from "../setup/claude-code.ts";
import { connectionLine, startChecks } from "../setup/connections.ts";
import {
  findOnPath,
  isReady,
  planSetup,
  type SetupPlan,
} from "../setup/plan.ts";
import { enforced, hookStatus, type Activation } from "../setup/status.ts";
import { reportAppliedHost } from "../setup/host-observation.ts";
import {
  setupChangeCount,
  setupChangesLabel,
} from "../setup/connected-plan-text.ts";
import { checkSetup } from "../setup/preflight.ts";
import { mark, planText } from "../setup/plan-text.ts";
import { spawnSync } from "../spawn.js";

const modeOf = (plan: SetupPlan) => plan.connect?.enforce ?? "on";
const WATCH_DETAIL =
  "watch mode lets tool calls continue; set enforce: on, lock and apply again";

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
    ...(values["replace-live"] ? ["--replace-live"] : []),
  ];
  const again = (verb: string) =>
    `\`${["nodrail", verb, ...words].join(" ")}\``;
  return { root, runtime, again };
}

/**
 * `nodrail plan`: what `nodrail apply` would set up here, by reading only.
 * Exits 1 when apply couldn't go ahead, so a script can tell.
 */
export async function plan(command: Command, proposed?: ProposedProject) {
  const { io, values } = command;
  const { root, runtime, again } = target(command, "plan");
  const result = planSetup({
    root,
    home: io.home,
    env: io.env,
    runtime,
    proposed,
  });
  const live = await checkSetup(command, root, result, proposed);
  const active = await activation(result, root, io);
  const revisionPending =
    policyRevisionPending(result) || live.changes?.publishes_policy === true;
  command.print(
    {
      runtime: result.runtime,
      team: result.team,
      entry: result.entry,
      ready: isReady(result),
      active: legacyActive(result, active),
      activation: active,
      hook_active:
        active.state === "configured" || active.state === "unknown"
          ? null
          : active.state === "verified",
      hook_configured: enforced(active),
      policy_revision_pending: revisionPending,
      mode: modeOf(result),
      revision: result.revision,
      applied: appliedRevisions(result),
      checks: result.checks,
      connections: result.connections.map(connectionLine),
      steps: result.steps,
      control_plane_changes: live.changes,
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
        planText(result, {
          project: basename(root),
          apply: again("apply"),
          publishes: live.publish !== null,
          details: values.details,
        }),
        "",
        hookStatus(active, result.connect?.decide === "cloud"),
        `Policy revision pending: ${revisionPending ? "yes" : "no"}.`,
        ...(result.runtime === "codex" && active.state !== "verified"
          ? [`Codex won't run the policy yet: ${active.detail}.`]
          : []),
      ].join("\n"),
  );
  if (!isReady(result))
    throw new CliError("The plan can't be applied yet: see what is marked !.");
  // Opt-in, so plan's exit keeps meaning "apply could go ahead".
  if (values["require-active"] && modeOf(result) === "watch")
    throw new CliError(`The policy isn't enforced here yet: ${WATCH_DETAIL}.`);
  if (values["require-active"] && enforced(active) && revisionPending)
    throw new CliError(
      "The locked policy revision is pending. Run nodrail apply.",
    );
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
  const policy = await checkSetup(command, root, reviewed);
  if (!values.json)
    command.say(
      planText(reviewed, {
        project: basename(root),
        footer: false,
        details: values.details,
      }),
    );
  if (!isReady(reviewed)) {
    if (values.json)
      command.print(
        {
          ready: false,
          checks: reviewed.checks,
          problems: reviewed.problems,
          control_plane_changes: policy.changes,
        },
        () => "",
      );
    throw new CliError(
      `Nothing was changed. Fix what is marked ! first, then run ${again("apply")} again.`,
    );
  }
  const local = setupChangeCount(reviewed);
  const remote = policy.publish !== null;
  const changed = local > 0 || remote;
  if (!(await confirmed(command, local, remote))) {
    io.out("Nothing was changed.");
    return;
  }
  // Accepted: now, and only now, each connection may start, to show it
  // offers what it declares. One that doesn't stops apply before any write.
  if (changed) await connectionsStart(command, reviewed, root);
  // Publish before installing the hook configuration that pins this policy.
  await applyRemotePolicy(command, place, policy);
  applySetup(place, reviewed, again("apply"));
  const inventoryNote = await reportAppliedHost(io, root, reviewed);
  if (inventoryNote) command.say(inventoryNote);
  await finish(command, reviewed, changed, { root, again });
}

async function applyRemotePolicy(
  command: Command,
  place: Place,
  policy: Awaited<ReturnType<typeof checkSetup>>,
) {
  if (!policy.publish) {
    if (policy.enrolled)
      await rememberCurrentEnrollment(place, policy.enrolled);
    return;
  }
  const { published, enrolled } = await publishPolicy(
    policy.publish,
    place,
    policy.enrolled,
  );
  if (!policy.publish.body.machine && policy.enrolled)
    await rememberCurrentEnrollment(place, policy.enrolled);
  if (published)
    command.say(
      `Published policy v${published.policy_revision} to ${policy.publish.api.url}.`,
    );
  if (enrolled) {
    const { url } = policy.publish.api;
    const runtime = command.values.runtime;
    const host = runtime ? ` --runtime ${runtime}` : "";
    command.say(
      [
        `Enrolled this machine at ${url}.`,
        "On a teammate’s machine, run these from the same project folder:",
        `  nodrail login --url ${url}`,
        `  nodrail plan${host}`,
        `  nodrail apply${host}`,
      ].join("\n"),
    );
  }
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
async function confirmed(
  { io, values }: Command,
  local: number,
  remote: boolean,
) {
  if ((!local && !remote) || values.yes) return true;
  if (!io.interactive)
    throw new UsageError(
      "`nodrail apply` asks before changing files. Run it at a terminal, or add --yes once you have read `nodrail plan`.",
    );
  const changes = [
    local ? setupChangesLabel(local) : null,
    remote ? "control plane changes" : null,
  ]
    .filter(Boolean)
    .join(" and ");
  const answer = await io.ask(`\nApply ${changes}? [y/N] `);
  return /^y(es)?$/i.test(answer.trim());
}

/** After the files: whether the host runs the policy, and how to start it. */
async function finish(
  command: Command,
  reviewed: SetupPlan,
  changed: boolean,
  { root, again }: { root: string; again: (verb: string) => string },
) {
  const { io, values } = command;
  const local = setupChangeCount(reviewed);
  const done = `Applied ${setupChangesLabel(local)}.`;
  const active = await activation(reviewed, root, io);
  const needsCodexTrust =
    reviewed.runtime === "codex" && active.state !== "verified";
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
      mode: modeOf(reviewed),
      restart,
      control_plane_changes: reviewed.remoteChanges,
    },
    () =>
      [
        "",
        done,
        hookStatus(active, reviewed.connect?.decide === "cloud"),
        ...(!changed ? ["Nothing to change."] : []),
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
        ...(modeOf(reviewed) === "watch"
          ? [`Policy mode: ${WATCH_DETAIL}.`]
          : reviewed.connect?.decide === "cloud"
            ? ["Policy mode: enforce."]
            : []),
        ...(reviewed.connect?.decide === "cloud"
          ? ["After running the agent, open Activity → Runs in the console."]
          : []),
        needsCodexTrust
          ? `Codex won't run the policy yet: ${active.detail}. Then run ${again("plan")} to check.`
          : `Run \`${[program, ...startArgs(reviewed)].join(" ")}\` in ${root === io.cwd ? "this folder" : root}: it starts as ${reviewed.entry}, behind the policy hook.`,
      ].join("\n"),
  );
  if (reviewed.start && io.interactive && !values.json && !needsCodexTrust)
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

/** Opens the host here, as the person would; its settings pick the agent. */
function start([program, ...args]: string[], root: string, io: Command["io"]) {
  const path = findOnPath(program!, io.env);
  if (path === null) throw new CliError(`${program} isn't on PATH.`);
  spawnSync(path, args, {
    cwd: root,
    env: io.env as NodeJS.ProcessEnv,
    stdio: "inherit",
  });
}
