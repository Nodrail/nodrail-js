import { disconnect, legacyEnrollment } from "../setup/disconnect.ts";
import {
  appliedEnrollments,
  rememberEnrollment,
  withEnrollmentLock,
  type EnrollmentRecord,
} from "../setup/applied-enrollment.ts";
import { HOST_NAMES } from "../setup/state.ts";
import { relative, resolve } from "node:path";
import type { Command } from "../context.ts";
import { CliError, UsageError } from "../io.ts";
import { holdProject, writeInProgress, type Place } from "../project/store.ts";
import {
  destroySetup,
  planDestroy,
  type DestroyPlan,
} from "../setup/destroy.ts";

const MARKS = {
  remove: "-",
  update: "~",
  keep: "=",
  conflict: "!",
  create: "+",
} as const;

const changesIn = (plan: DestroyPlan) =>
  plan.steps.filter(
    (step) => step.action === "remove" || step.action === "update",
  ).length;

const plural = (count: number) => `${count} change${count === 1 ? "" : "s"}`;

const restartNotes = (plan: DestroyPlan) =>
  plan.hosts.length
    ? [
        "Restart open sessions for the removed hosts in this project so they release their old hooks.",
        "Any policy published to the control plane stays live in its environment.",
      ]
    : [];

function destroyText(plan: DestroyPlan) {
  if (plan.hosts.length === 0)
    return "Nothing here was set up by nodrail apply. Nothing was changed.";
  const width = Math.max(0, ...plan.steps.map((step) => step.path.length));
  return [
    `Destroy what nodrail apply set up for ${plan.hosts.map((host) => HOST_NAMES[host]).join(" and ")}`,
    "",
    "Files",
    ...plan.steps.map(
      (step) =>
        `  ${MARKS[step.action]} ${step.path.padEnd(width)}  ${step.why}`,
    ),
    "",
    ...plan.notes.map((note) => `  ${note}`),
  ].join("\n");
}

/**
 * `nodrail destroy`: takes out what `nodrail apply` set up, for every host
 * it set up or the one `--runtime` names, after showing what and asking.
 * Your edits, your own entries, nodrail.yaml, the lock and connection data
 * stay.
 */
export async function destroy(command: Command) {
  const { io, values } = command;
  if (command.args.length > 1)
    throw new UsageError(
      "Usage: nodrail destroy [<project folder>] [--runtime claude-code|codex|copilot] [--yes]",
    );
  if (values.json && !values.yes)
    throw new UsageError("`nodrail destroy --json` needs --yes: it can't ask.");
  const folder = command.args[0];
  const root = folder === undefined ? io.cwd : resolve(io.cwd, folder);
  const named = relative(io.cwd, root);
  const again = `\`${["nodrail destroy", ...(named === "" ? [] : [named]), ...(values.runtime ? [`--runtime ${values.runtime}`] : [])].join(" ")}\``;
  const place = { root, home: io.home, env: io.env, runtime: values.runtime };
  if (writeInProgress(place)) holdProject(place, () => undefined);
  const reviewed = planDestroy(place);
  const saved = appliedEnrollments(place);
  const legacy = saved.length
    ? null
    : await legacyEnrollment(io.home, root, reviewed);
  const bindings = legacy ? [legacy] : saved;
  if (!values.json) {
    io.out(destroyText(reviewed));
    if (bindings.length)
      io.out(
        "Destroy disconnects this machine for every runtime using this project's enrollment.",
      );
  }
  const count = changesIn(reviewed);
  if (!(await confirmed(command, count, bindings.length > 0))) {
    io.out("Nothing was changed.");
    return;
  }
  if (legacy)
    await withEnrollmentLock(place, legacy, () => {
      if (appliedEnrollments(place).length)
        throw new CliError(
          "The machine enrollment changed. Run nodrail destroy again.",
        );
      rememberEnrollment(place, legacy);
      return Promise.resolve();
    });
  if (reviewed.hosts.length > 0) destroySetup(place, reviewed, again);
  await finishDestroy(command, place, reviewed, bindings);
}

async function finishDestroy(
  command: Command,
  place: Place,
  reviewed: DestroyPlan,
  bindings: EnrollmentRecord[],
) {
  const count = changesIn(reviewed);
  const errors: string[] = [];
  const next = restartNotes(reviewed);
  let revoked = false;
  let cleared = 0;
  for (const binding of bindings) {
    const result = await disconnect(command.io, place, binding);
    if ("error" in result) {
      errors.push(result.error);
      continue;
    }
    if (result.status === "revoked") revoked = true;
    else cleared++;
    next.push(...result.notes);
  }
  command.print(
    {
      destroyed: reviewed.hosts,
      credential_revoked: bindings.length
        ? revoked && !errors.length
        : undefined,
      enrollment_intents_cleared: cleared || undefined,
      steps: reviewed.steps,
      notes: [...reviewed.notes, ...next, ...errors],
    },
    () =>
      reviewed.hosts.length === 0 && next.length === 0
        ? ""
        : [
            "",
            count > 0 ? `Made ${plural(count)}.` : "Nothing to remove.",
            ...next,
          ].join("\n"),
  );
  if (errors.length) throw new CliError(errors.join("\n"));
}

async function confirmed(
  { io, values }: Command,
  count: number,
  enrolled: boolean,
) {
  if (values.yes || (count === 0 && !enrolled)) return true;
  if (!io.interactive)
    throw new UsageError(
      "`nodrail destroy` asks before removing files. Run it at a terminal, or add --yes.",
    );
  const prompt = count ? `Make ${plural(count)}?` : "Disconnect this machine?";
  return /^y(es)?$/i.test((await io.ask(`\n${prompt} [y/N] `)).trim());
}
