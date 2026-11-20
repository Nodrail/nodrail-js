import { HOST_NAMES } from "./state.ts";
import { existsSync, readdirSync, readFileSync, rmdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Env } from "../config.ts";
import { CliError } from "../io.ts";
import { journalWriter, onDisk, replayReviewed } from "../project/journal.ts";
import { holdProject, type Place } from "../project/store.ts";
import { claudeUndoSteps, type UndoStep } from "./claude-settings.ts";
import { removalStep, type Step } from "./plan.ts";
import { CODEX_MARKETPLACE } from "./plugins.ts";
import {
  readState,
  STATE_FILE,
  type Runtime,
  type SetupState,
} from "./state.ts";

/**
 * `nodrail destroy`: everything `apply` set up for a host, taken out, and
 * only that. It reads what the state says nodrail wrote, not nodrail.yaml,
 * so it works on a project whose setup no longer reads. Kept, always:
 * nodrail.yaml, the lock, the resources, each connection's data, and any
 * file edited since nodrail wrote it. A file another host still needs stays
 * for it. What a person installed for their whole host, such as a Codex
 * plugin, is named, never removed.
 */
export type DestroyPlan = {
  /** The hosts taken out. */
  hosts: Runtime[];
  steps: Step[];
  /** Shared settings files with nodrail's entries out, by path. */
  merged: Record<string, Record<string, unknown>>;
  notes: string[];
  state: SetupState | null;
};

export function planDestroy(input: {
  root: string;
  home: string;
  env: Env;
  runtime?: string;
}): DestroyPlan {
  const { root } = input;
  const state = readState(root);
  const recorded = Object.keys(state?.hosts ?? {}) as Runtime[];
  if (
    input.runtime !== undefined &&
    input.runtime !== "claude-code" &&
    input.runtime !== "codex"
  )
    throw new CliError(
      `--runtime is claude-code or codex, not ${input.runtime}.`,
    );
  const hosts =
    input.runtime === undefined
      ? recorded
      : recorded.filter((host) => host === input.runtime);
  const staying = recorded.filter((host) => !hosts.includes(host));
  const steps: Step[] = [];
  const merged: Record<string, Record<string, unknown>> = {};
  for (const host of hosts)
    hostSteps({ root, state: state!, host, staying }, steps, merged);
  return {
    hosts,
    steps,
    merged,
    notes: notesFor(input, state, hosts, staying),
    state,
  };
}

/** One host's files and shared settings, each path once. */
function hostSteps(
  at: { root: string; state: SetupState; host: Runtime; staying: Runtime[] },
  steps: Step[],
  merged: Record<string, Record<string, unknown>>,
) {
  const entry = at.state.hosts[at.host]!;
  const known = (path: string) => steps.some((step) => step.path === path);
  for (const [path, hash] of Object.entries(entry.files))
    if (!known(path)) steps.push(fileStep(at, path, hash));
  if (at.host !== "claude-code") return;
  for (const undo of claudeUndoSteps(at.root, entry.settings)) {
    if (known(undo.path)) continue;
    steps.push(withoutValue(undo));
    if (undo.value) merged[undo.path] = undo.value;
  }
}

const withoutValue = ({ path, action, why }: UndoStep): Step => ({
  path,
  action,
  why,
});

/** A file nodrail wrote: removed while it holds what was written. */
function fileStep(
  {
    root,
    state,
    staying,
  }: { root: string; state: SetupState; staying: Runtime[] },
  path: string,
  hash: string,
): Step {
  const needed = staying.filter(
    (host) => state.hosts[host]?.files[path] !== undefined,
  );
  if (needed.length > 0)
    return {
      path,
      action: "keep",
      why: `kept for ${needed.map((host) => HOST_NAMES[host]).join(" and ")}`,
    };
  return removalStep(root, path, hash, {
    edited: "edited since nodrail wrote it: kept, yours now",
    removed: "written by nodrail",
  });
}

/** What stays, and what only the person can take out. */
function notesFor(
  input: { root: string; home: string; env: Env },
  state: SetupState | null,
  hosts: Runtime[],
  staying: Runtime[],
) {
  if (hosts.length === 0) return [];
  const data = new Map<string, string[]>();
  for (const host of hosts)
    for (const [name, paths] of Object.entries(state!.hosts[host]!.data ?? {}))
      data.set(name, paths);
  return [
    "Kept: nodrail.yaml, nodrail.lock.yaml and the files they name.",
    ...[...data].map(
      ([name, paths]) =>
        `Kept: the data of connection ${name}, at ${paths.join(", ")}. Agents can reach it with file tools once the hook is gone.`,
    ),
    ...(hosts.includes("codex") ? codexPluginNotes(input) : []),
    ...(staying.length > 0
      ? [
          `${staying.map((host) => HOST_NAMES[host]).join(" and ")} stays set up.`,
        ]
      : []),
  ];
}

/** The project's plugins Codex has installed: for every folder, so the person's to remove. */
function codexPluginNotes({
  root,
  home,
  env,
}: {
  root: string;
  home: string;
  env: Env;
}) {
  let listed: { name?: unknown; plugins?: { name?: unknown }[] };
  try {
    listed = JSON.parse(
      readFileSync(join(root, CODEX_MARKETPLACE), "utf8"),
    ) as typeof listed;
  } catch {
    return [];
  }
  const market = typeof listed.name === "string" ? listed.name : null;
  if (market === null) return [];
  const cache = join(
    env.CODEX_HOME ?? join(home, ".codex"),
    "plugins/cache",
    market,
  );
  return (listed.plugins ?? [])
    .map((plugin) => plugin.name)
    .filter(
      (name): name is string =>
        typeof name === "string" && existsSync(join(cache, name)),
    )
    .map(
      (name) =>
        `Codex still has plugin ${name} installed, for every folder: run \`codex plugin remove ${name}@${market}\` if you no longer want it.`,
    );
}

/** What the person reviewed. */
const fingerprint = (plan: DestroyPlan) =>
  JSON.stringify({
    hosts: plan.hosts,
    steps: plan.steps,
    merged: plan.merged,
    state: plan.state,
  });

/** The state once the hosts are out; null when none is left. */
function nextState(plan: DestroyPlan): SetupState | null {
  const hosts = Object.fromEntries(
    Object.entries(plan.state?.hosts ?? {}).filter(
      ([host]) => !plan.hosts.includes(host as Runtime),
    ),
  );
  return Object.keys(hosts).length === 0 ? null : { state: 2, hosts };
}

function journalFor(root: string, plan: DestroyPlan) {
  const { entries, contents, change } = journalWriter(root);
  for (const step of plan.steps) {
    if (step.action === "remove") change(step.path, null);
    if (step.action === "update")
      change(
        step.path,
        Buffer.from(`${JSON.stringify(plan.merged[step.path], null, 2)}\n`),
      );
  }
  const state = nextState(plan);
  if (state === null) {
    if (onDisk(root, STATE_FILE) !== null) change(STATE_FILE, null);
  } else change(STATE_FILE, Buffer.from(`${JSON.stringify(state, null, 2)}\n`));
  return { entries, contents };
}

/**
 * Takes out what the reviewed plan showed, as the project's only writer,
 * then the folders that held only nodrail's files. It plans again inside
 * the hold and refuses if anything differs from what was reviewed.
 */
export function destroySetup(
  place: Place & { env: Env; runtime?: string },
  reviewed: DestroyPlan,
  again: string,
) {
  const left = holdProject(place, (folder) =>
    replayReviewed(
      folder,
      place.root,
      {
        reviewed,
        now: planDestroy(place),
        same: (a, b) => fingerprint(a) === fingerprint(b),
        again,
      },
      (plan) => journalFor(place.root, plan),
    ),
  );
  for (const step of reviewed.steps)
    if (step.action === "remove") pruneFolders(place.root, dirname(step.path));
  if (left.length > 0)
    throw new CliError(
      [
        "These changed meanwhile and were left as they are:",
        ...left.map((path) => `  ${path}`),
      ].join("\n"),
    );
}

/** Empty folders a removed file leaves, up to the project folder. */
function pruneFolders(root: string, folder: string) {
  for (
    let at = folder;
    at !== "." && at !== "" && at !== "/";
    at = dirname(at)
  ) {
    const full = join(root, at);
    try {
      if (readdirSync(full).length > 0) return;
      rmdirSync(full);
    } catch {
      return;
    }
  }
}
