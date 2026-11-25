import { hookStatus } from "../setup/status.ts";
import { projectPolicyStatus } from "../setup/policy-status.ts";
import { HOST_NAMES } from "../setup/state.ts";
import { resolve } from "node:path";
import type { Command } from "../context.ts";
import { CliError, UsageError } from "../io.ts";
import type { Drift } from "../setup/inventory.ts";
import {
  hostStatuses,
  inStep,
  lastObservation,
  STALE_AFTER_MS,
  type HostStatus,
  type Observing,
} from "../setup/observe.ts";

const OBSERVING: Record<Observing, string> = {
  on: "at each session start",
  untrusted:
    "set up, but Codex runs it only once you trust it: open codex here and run /hooks",
  off: "off",
  unknown: "unknown",
};

const MARK: Record<Drift["change"], string> = {
  edited: "~",
  missing: "-",
  changed: "!",
};

function revisionLine({ revision, host }: HostStatus) {
  const short = (sha: string | null) =>
    sha ? sha.slice(0, 12) : "none recorded";
  if (revision.locked === null)
    return `  Revision: applied from workspace ${short(revision.applied)}`;
  return revision.applied === revision.locked
    ? `  Revision: workspace ${short(revision.applied)}, as locked`
    : `  Revision: applied from workspace ${short(revision.applied)}; the lock is at ${short(revision.locked)}: run \`nodrail plan --runtime ${host}\`, then \`nodrail apply --runtime ${host}\``;
}

function policyText(policy: ReturnType<typeof projectPolicyStatus>) {
  const { mode, source, remote } = policy;
  const lines = [
    source
      ? `Source compared with lock: ${source}`
      : "Source matches the lock.",
    mode === "watch"
      ? "Mode: watch (ordinary policy denials let calls continue)."
      : "Mode: enforce.",
  ];
  if (remote?.state === "unchecked")
    lines.push(
      "Connected policy: no hook check recorded for this revision yet.",
    );
  if (remote?.state === "live")
    lines.push(
      `Connected policy: last verified with the control plane at ${remote.at}.`,
    );
  if (remote?.state === "cached")
    lines.push(
      `Connected policy: the control plane didn't answer at ${remote.at}; the hook used the verified cache.`,
    );
  if (remote?.state === "unavailable")
    lines.push(
      `Connected policy: no usable policy at ${remote.at}; the hook ${mode === "watch" ? "let ordinary calls continue" : "blocked calls"}.${remote.detail ? ` ${remote.detail}.` : ""}`,
    );
  return lines.join("\n");
}

function hostText(status: HostStatus, connected: boolean) {
  const lines = [
    `${HOST_NAMES[status.host]}${status.entry ? `: starts as ${status.entry}` : ""}`,
    revisionLine(status),
    `  ${hookStatus(status.activation, connected)}`,
    `  Observation: ${OBSERVING[status.observing]}.`,
  ];
  lines.push(
    ...(status.drift.length === 0
      ? ["  Since apply: nothing changed."]
      : [
          "  Since apply:",
          ...status.drift.map(
            (each) => `    ${MARK[each.change]} ${each.path}  ${each.detail}`,
          ),
        ]),
  );
  if (status.unmanaged.length > 0) {
    lines.push(
      "  Not set up by nodrail (the hook still decides their tool calls):",
    );
    for (const scope of ["project", "user"] as const) {
      const items = status.unmanaged.filter((each) => each.scope === scope);
      if (items.length > 0)
        lines.push(
          `    ${scope === "project" ? "This folder" : "Yours, in every folder"}:`,
          ...items.map(
            (each) => `      ${each.kind} ${each.name}  (${each.where})`,
          ),
        );
    }
  }
  return lines.join("\n");
}

/** When the session-start hook last recorded this project, and whether that's stale. */
function lastLine(last: ReturnType<typeof lastObservation>) {
  if (last === null)
    return "Last recorded: never (the session-start hook records one when a session starts).";
  const age = Date.now() - Date.parse(last.at);
  const hours = Math.floor(age / 3_600_000);
  const when = hours < 1 ? "less than an hour ago" : `${hours} h ago`;
  return `Last recorded: ${last.at} (${when})${age > STALE_AFTER_MS ? ", stale: no session here in 24 h" : ""}; ${last.inStep ? "in step" : "not in step"} then.`;
}

/**
 * `nodrail status`: each host here as nodrail last set it up, next to what
 * is there now. It reads only, offline, and changes nothing. Exits 1 when
 * a host drifted, isn't from the locked revision, or doesn't enforce the
 * policy, or when nothing is set up.
 */
export async function status(command: Command) {
  const { io, values } = command;
  if (command.args.length > 1)
    throw new UsageError(
      "Usage: nodrail status [<project folder>] [--runtime claude-code|codex|copilot]",
    );
  const root =
    command.args[0] === undefined ? io.cwd : resolve(io.cwd, command.args[0]);
  const statuses = await hostStatuses(
    { root, home: io.home, env: io.env },
    values.runtime,
  );
  if (statuses.length === 0)
    throw new CliError(
      values.runtime === undefined
        ? "Nothing here is set up by nodrail apply. Run `nodrail plan` to see what it would set up."
        : `${values.runtime} isn't set up here by nodrail apply.`,
    );
  const last = lastObservation(io.home, root);
  const policy = projectPolicyStatus(root, io.home);
  const ready =
    statuses.every(inStep) &&
    !policy.source &&
    policy.mode === "on" &&
    (policy.remote === null || policy.remote.state === "live");
  command.print(
    { hosts: statuses, inStep: ready, lastObservation: last, policy },
    () =>
      [
        policyText(policy),
        ...statuses.map((status) => hostText(status, policy.remote !== null)),
        lastLine(last),
      ].join("\n\n"),
  );
  if (!ready)
    throw new CliError(
      "The installed setup, source lock or connected policy check needs attention. See above.",
    );
}
