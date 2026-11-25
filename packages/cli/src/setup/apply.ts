import { recordAppliedHook } from "@nodrail/policy-engine/command-line";
import { SETTINGS_FILE } from "./claude-code.ts";
import type { Env } from "../config.ts";
import { CliError } from "../io.ts";
import { onDisk, journalWriter, replayReviewed } from "../project/journal.ts";
import { sha256 } from "../project/lockfile.ts";
import { holdProject, type Place } from "../project/store.ts";
import { planSetup, type SetupPlan } from "./plan.ts";
import {
  hostState,
  otherOwners,
  STATE_FILE,
  type HostState,
  type SetupState,
} from "./state.ts";

/** What the person reviewed: every step, and the bytes behind each. */
function fingerprint(plan: SetupPlan) {
  return JSON.stringify({
    steps: plan.steps,
    problems: plan.problems,
    files: plan.files.map((file) => [file.path, sha256(file.content)]),
    merged: plan.merged,
    // A lock made meanwhile is another revision, even with the same files.
    revision: plan.revision,
  });
}

const same = (a: SetupPlan, b: SetupPlan) => fingerprint(a) === fingerprint(b);

/** The plan's changes as journal entries, the setup state last. */
function journalFor(root: string, plan: SetupPlan) {
  const { entries, contents, change } = journalWriter(root);
  for (const step of plan.steps) {
    if (step.action === "remove") change(step.path, null);
    if (step.action !== "create" && step.action !== "update") continue;
    const value = plan.merged[step.path];
    if (value)
      change(step.path, Buffer.from(`${JSON.stringify(value, null, 2)}\n`));
    else
      change(
        step.path,
        plan.files.find((file) => file.path === step.path)!.content,
      );
  }
  const state = nextState(plan);
  const text = Buffer.from(`${JSON.stringify(state, null, 2)}\n`);
  if (onDisk(root, STATE_FILE) !== sha256(text)) change(STATE_FILE, text);
  return { entries, contents };
}

/**
 * The state once the plan is applied: this host's entry made anew, and each
 * other host's kept, with the new hash of any shared file written now.
 */
/** The revision applied, as the state records it: digests that exist. */
/** Claude Code's plugin settings nodrail set, when it set any. */
const pluginNames = ({ claudePlugins }: SetupPlan) =>
  claudePlugins.enabled.length > 0
    ? {
        marketplaces: claudePlugins.marketplaces,
        plugins: claudePlugins.enabled,
      }
    : {};

const revisionOf = ({ revision }: SetupPlan) => {
  const known = Object.fromEntries(
    Object.entries(revision).filter(([, digest]) => digest !== null),
  ) as { policy?: string; workspace?: string };
  return Object.keys(known).length > 0 ? { revision: known } : {};
};

function nextState(plan: SetupPlan): SetupState {
  const { runtime } = plan;
  // nodrail owns what it writes, and what it owned already, for this host or
  // the other: never a file that merely matched, which is the person's and
  // must never be removed.
  const written = new Set(
    plan.steps
      .filter((step) => step.action === "create" || step.action === "update")
      .map((step) => step.path),
  );
  const owned = (path: string) =>
    written.has(path) ||
    (plan.steps.some((step) => step.path === path && step.action === "keep") &&
      (hostState(plan.state, runtime)?.files[path] !== undefined ||
        otherOwners(plan.state, runtime, path).length > 0));
  const hashes = new Map(
    plan.files.map((file) => [file.path, sha256(file.content)]),
  );
  const mine: HostState = {
    files: Object.fromEntries([...hashes].filter(([path]) => owned(path))),
    // Only Claude Code's settings are shared with the person's own.
    settings:
      runtime === "claude-code"
        ? {
            agent: plan.entry,
            mcpServers: plan.connections.map((each) => each.name),
            ...pluginNames(plan),
          }
        : {},
    ...dataOf(plan.connections),
    ...revisionOf(plan),
  };
  const hosts: SetupState["hosts"] = {};
  for (const [name, entry] of Object.entries(plan.state?.hosts ?? {}))
    if (name !== runtime && entry)
      hosts[name as keyof typeof hosts] = {
        ...entry,
        files: Object.fromEntries(
          Object.entries(entry.files).map(([path, hash]) => [
            path,
            written.has(path) ? hashes.get(path)! : hash,
          ]),
        ),
      };
  hosts[runtime] = mine;
  return { state: 2, hosts };
}

/** Each connection's declared data, when any keeps some. */
function dataOf(connections: SetupPlan["connections"]) {
  const kept = connections.filter((each) => each.spec.data);
  return kept.length === 0
    ? {}
    : {
        data: Object.fromEntries(
          kept.map((each) => [each.name, each.spec.data!]),
        ),
      };
}

/**
 * Applies a reviewed plan as the project's only writer. It plans again
 * inside the hold and refuses if anything differs from what was reviewed.
 * The changes are journaled first, so a stop partway is finished by the next
 * nodrail, and a file someone changes meanwhile is left alone and named.
 */
export function applySetup(
  place: Place & { env: Env; runtime?: string },
  reviewed: SetupPlan,
  again = "`nodrail apply`",
) {
  holdProject(place, (folder) => {
    const left = replayReviewed(
      folder,
      place.root,
      { reviewed, now: planSetup({ ...place, held: true }), same, again },
      (plan) => journalFor(place.root, plan),
    );
    if (left.length > 0)
      throw new CliError(
        [
          "These changed while applying and were left as they are:",
          ...left.map((path) => `  ${path}`),
          `Run ${again.replace("nodrail apply", "nodrail plan")} to see where things stand.`,
        ].join("\n"),
      );
    const settings = reviewed.merged[SETTINGS_FILE];
    if (reviewed.runtime === "claude-code" && settings)
      recordAppliedHook(place.home, place.root, settings);
  });
}
