import { json } from "./hook-settings.ts";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import {
  enqueue,
  telemetryId,
  spoolFolder,
  startSender,
  wakeSender,
  type SpanRecord,
} from "@nodrail/policy-engine/command-line";
import type { Env } from "../config.ts";
import { isObserveHook } from "./claude-code.ts";
import { TELEMETRY_FILE } from "./connections.ts";
import { codexHooks, hookActivation } from "./codex.ts";
import { copilotActivation, COPILOT_HOOKS } from "./copilot.ts";
import { copilotUnmanaged } from "./copilot-inventory.ts";
import {
  appliedCodexHook,
  claudeSettingsDrift,
  claudeUnmanaged,
  codexUnmanaged,
  fileDrift,
  hookAgent,
  type Drift,
  type Unmanaged,
} from "./inventory.ts";
import { findOnPath } from "./plan.ts";
import { readState, type HostState, type Runtime } from "./state.ts";
import {
  claudeActivation,
  enforced,
  lockedRevision,
  type Activation,
} from "./status.ts";

/**
 * Observation (W3): what `nodrail status` shows, recorded. The session-start
 * hook `apply` writes runs `nodrail observe`, which records the latest
 * observation of each project in the person's home, never in the project.
 * By default only counts are kept; the names of what nodrail doesn't
 * manage only when the project says so (`observe: { names: true }`), since
 * they say which tools a person uses. When the project sends telemetry,
 * the observation goes there too, as the same fields; otherwise nothing is
 * sent anywhere.
 */

/** Whether the session-start observation runs: on, waiting for trust, or off. */
export type Observing = "on" | "untrusted" | "off" | "unknown";

export type HostStatus = {
  host: Runtime;
  entry: string | null;
  revision: { applied: string | null; locked: string | null };
  activation: Activation;
  observing: Observing;
  drift: Drift[];
  unmanaged: Unmanaged[];
};

type Place = { root: string; home: string; env: Env };

/** Whether the host is as nodrail last set it up, from the locked revision, enforced. */
export const inStep = (status: HostStatus) =>
  status.drift.length === 0 &&
  enforced(status.activation) &&
  (status.revision.locked === null ||
    status.revision.applied === status.revision.locked);

/** Each host the state records, or the one asked for. */
export async function hostStatuses(place: Place, runtime?: string) {
  const state = readState(place.root);
  const hosts = (Object.keys(state?.hosts ?? {}) as Runtime[]).filter(
    (host) => runtime === undefined || host === runtime,
  );
  return Promise.all(
    hosts.map((host) => hostStatus(place, host, state!.hosts[host]!)),
  );
}

async function hostStatus(
  place: Place,
  host: Runtime,
  entry: HostState,
): Promise<HostStatus> {
  const { root } = place;
  const revision = {
    applied: entry.revision?.workspace ?? null,
    locked: lockedRevision(root).workspace,
  };
  const drift = fileDrift(root, entry);
  if (host === "claude-code") {
    const unmanaged = claudeUnmanaged({ ...place, entry });
    return {
      host,
      entry: entry.settings.agent ?? null,
      revision,
      activation: claudeActivation(place),
      observing: claudeObserving(root),
      drift: [...drift, ...claudeSettingsDrift(root, entry)],
      unmanaged,
    };
  }
  if (host === "copilot")
    return {
      host,
      entry: copilotEntry(root),
      revision,
      activation: copilotActivation(place),
      observing: copilotObserving(root),
      drift,
      unmanaged: copilotUnmanaged({ ...place, entry }),
    };
  const ours = appliedCodexHook(root);
  const codex = findOnPath("codex", place.env);
  const hooks =
    codex === null
      ? "codex isn't on PATH to ask"
      : await codexHooks(codex, root, place.env);
  const listed = typeof hooks === "string" ? null : hooks;
  const activation: Activation =
    listed === null
      ? { state: "unknown", detail: hooks as string }
      : ours === null
        ? {
            state: "inactive",
            detail:
              ".codex/hooks.json no longer holds nodrail's hook; run nodrail apply",
          }
        : hookActivation(listed, ours);
  const observe = listed?.find(
    (hook) =>
      hook.source === "project" &&
      hook.eventName === "sessionStart" &&
      isObserveHook(hook.command ?? ""),
  );
  return {
    host,
    entry: hookAgent(ours),
    revision,
    activation,
    observing:
      listed === null
        ? "unknown"
        : !observe
          ? "off"
          : observe.trustStatus === "trusted"
            ? "on"
            : "untrusted",
    drift,
    unmanaged: codexUnmanaged({
      ...place,
      entry,
      hooks: listed,
      ourHook: ours,
    }),
  };
}

/** The agent nodrail's Copilot hook judges calls as. */
function copilotEntry(root: string) {
  const command = copilotHook(root, "preToolUse");
  return / --agent ([^\s]+)/.exec(command ?? "")?.[1] ?? null;
}

/** Whether nodrail's Copilot hook file runs the observation at session start. */
const copilotObserving = (root: string): Observing =>
  isObserveHook(copilotHook(root, "sessionStart") ?? "") ? "on" : "off";

function copilotHook(root: string, event: string) {
  const hooks = (json(join(root, COPILOT_HOOKS))?.hooks ?? {}) as Record<
    string,
    { bash?: string }[]
  >;
  return hooks[event]?.[0]?.bash ?? null;
}

/** Whether Claude Code's settings hold the observation hook. */
function claudeObserving(root: string): Observing {
  try {
    const settings = JSON.parse(
      readFileSync(join(root, ".claude/settings.json"), "utf8"),
    ) as {
      hooks?: { SessionStart?: { hooks?: { command?: string }[] }[] };
    };
    return (settings.hooks?.SessionStart ?? []).some((group) =>
      (group.hooks ?? []).some((hook) => isObserveHook(hook.command ?? "")),
    )
      ? "on"
      : "off";
  } catch {
    return "off";
  }
}

/** One observation, as it is kept: counts, and names only when asked. */
export type Observation = {
  observation: 1;
  at: string;
  project: string;
  /** Where the project is; kept on this machine, never sent. */
  root: string;
  inStep: boolean;
  hosts: {
    host: Runtime;
    entry: string | null;
    revision: { applied: string | null; locked: string | null };
    activation: Activation["state"];
    drift: number;
    unmanaged: Partial<Record<Unmanaged["kind"], number>>;
    /** Only with `observe: { names: true }`. */
    names?: { drift: string[]; unmanaged: string[] };
  }[];
};

export function observation(
  root: string,
  statuses: HostStatus[],
  names: boolean,
  now = new Date(),
): Observation {
  return {
    observation: 1,
    at: now.toISOString(),
    project: basename(root),
    root,
    inStep: statuses.every(inStep),
    hosts: statuses.map((status) => {
      const unmanaged: Partial<Record<Unmanaged["kind"], number>> = {};
      for (const item of status.unmanaged)
        unmanaged[item.kind] = (unmanaged[item.kind] ?? 0) + 1;
      return {
        host: status.host,
        entry: status.entry,
        revision: status.revision,
        activation: status.activation.state,
        drift: status.drift.length,
        unmanaged,
        ...(names
          ? {
              names: {
                drift: status.drift.map((each) => each.path),
                unmanaged: status.unmanaged.map(
                  (each) => `${each.kind} ${each.name} (${each.scope})`,
                ),
              },
            }
          : {}),
      };
    }),
  };
}

/** Where a project's latest observation is kept: in the home folder, by the project's real path. */
export function observationFile(home: string, root: string) {
  const key = createHash("sha256")
    .update(realpathSync(root))
    .digest("hex")
    .slice(0, 16);
  return join(home, ".nodrail", "observations", `${key}.json`);
}

/** Keeps only the latest: written whole, then renamed over the last. */
export function recordObservation(
  home: string,
  root: string,
  value: Observation,
) {
  const file = observationFile(home, root);
  mkdirSync(join(file, ".."), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, file);
}

export function lastObservation(
  home: string,
  root: string,
): Observation | null {
  try {
    return JSON.parse(
      readFileSync(observationFile(home, root), "utf8"),
    ) as Observation;
  } catch {
    return null;
  }
}

/** At most this much of a names list leaves the machine. */
const MAX_NAMES = 4000;

const names = (list: string[]) => {
  const kept: string[] = [];
  for (const name of list) {
    if (JSON.stringify([...kept, name]).length > MAX_NAMES) break;
    kept.push(name);
  }
  return JSON.stringify(kept);
};

const slug = (kind: string) => kind.toLowerCase().replaceAll(" ", "_");

/**
 * An observation as it is sent (W3.3): one span per host, one trace per
 * observation, over the project's telemetry. Counts, revisions and
 * activation; names only when the project opted in; never the project's
 * path or anything under home.
 */
export function observationSpans(
  record: Observation,
  machine: string,
): SpanRecord[] {
  const traceId = randomBytes(16).toString("hex");
  const at = (BigInt(Date.parse(record.at)) * 1_000_000n).toString();
  return record.hosts.map((host) => {
    const attributes: Record<string, string> = {
      "nodrail.machine": machine,
      "nodrail.host": host.host,
      "nodrail.activation": host.activation,
      "nodrail.in_step": String(record.inStep),
      "nodrail.drift": String(host.drift),
    };
    if (host.entry) attributes["nodrail.agent"] = host.entry;
    if (host.revision.applied)
      attributes["nodrail.workspace.revision"] = host.revision.applied;
    if (host.revision.locked)
      attributes["nodrail.workspace.locked"] = host.revision.locked;
    for (const [kind, count] of Object.entries(host.unmanaged))
      attributes[`nodrail.unmanaged.${slug(kind)}`] = String(count);
    if (host.names) {
      attributes["nodrail.drift.names"] = names(host.names.drift);
      attributes["nodrail.unmanaged.names"] = names(host.names.unmanaged);
    }
    return {
      traceId,
      spanId: randomBytes(8).toString("hex"),
      name: "nodrail.observation",
      start: at,
      end: at,
      attributes,
    };
  });
}

/**
 * Queues the observation where the project's decisions wait, when the
 * project sends telemetry, and wakes the sender: offline, it waits there,
 * bounded, like every span. Answers whether it was queued.
 */
export function sendObservation(
  home: string,
  root: string,
  record: Observation,
  self: readonly string[],
) {
  const file = join(root, TELEMETRY_FILE);
  if (!existsSync(file)) return false;
  const folder = spoolFolder(home, file);
  for (const span of observationSpans(record, telemetryId(home)))
    enqueue(folder, span);
  wakeSender(folder, () => startSender(self, folder, file));
  return true;
}

/** An observation older than this is stale. */
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
