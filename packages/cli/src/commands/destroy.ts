import { HOST_NAMES } from "../setup/state.ts";
import { relative, resolve } from "node:path";
import type { Command } from "../context.ts";
import { UsageError } from "../io.ts";
import { holdProject, writeInProgress } from "../project/store.ts";
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
      "Usage: nodrail destroy [<project folder>] [--runtime claude-code|codex] [--yes]",
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
  if (!values.json) io.out(destroyText(reviewed));
  const count = changesIn(reviewed);
  if (reviewed.hosts.length > 0 && count > 0 && !values.yes) {
    if (!io.interactive)
      throw new UsageError(
        "`nodrail destroy` asks before removing files. Run it at a terminal, or add --yes.",
      );
    const answer = await io.ask(`\nMake ${plural(count)}? [y/N] `);
    if (!/^y(es)?$/i.test(answer.trim())) {
      io.out("Nothing was changed.");
      return;
    }
  }
  if (reviewed.hosts.length > 0) destroySetup(place, reviewed, again);
  command.print(
    { destroyed: reviewed.hosts, steps: reviewed.steps, notes: reviewed.notes },
    () =>
      reviewed.hosts.length === 0
        ? ""
        : [
            "",
            count > 0 ? `Made ${plural(count)}.` : "Nothing to remove.",
            `Sessions already open keep what they started with; new ones start without nodrail's agents and hook.`,
          ].join("\n"),
  );
}
