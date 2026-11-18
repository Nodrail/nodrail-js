import type { Env } from "../config.ts";
import { CliError } from "../io.ts";
import {
  onDisk,
  replayJournal,
  stageJournal,
  type JournalEntry,
} from "../project/journal.ts";
import { sha256 } from "../project/lockfile.ts";
import { holdProject, type Place } from "../project/store.ts";
import { SETTINGS_FILE } from "./claude-code.ts";
import { planSetup, type SetupPlan } from "./plan.ts";
import { STATE_FILE, type SetupState } from "./state.ts";

/** What the person reviewed: every step, and the bytes behind each. */
function fingerprint(plan: SetupPlan) {
  return JSON.stringify({
    steps: plan.steps,
    problems: plan.problems,
    files: plan.files.map((file) => [file.path, sha256(file.content)]),
    settings: plan.settings,
  });
}

/** The plan's changes as journal entries, the setup state last. */
function journalFor(root: string, plan: SetupPlan) {
  const contents = new Map<string, Buffer>();
  const entries: JournalEntry[] = [];
  const change = (path: string, bytes: Buffer | null) => {
    if (bytes) contents.set(path, bytes);
    entries.push({
      path,
      before: onDisk(root, path),
      after: bytes ? sha256(bytes) : null,
    });
  };
  for (const step of plan.steps) {
    if (step.action === "remove") change(step.path, null);
    if (step.action !== "create" && step.action !== "update") continue;
    if (step.path === SETTINGS_FILE)
      change(
        step.path,
        Buffer.from(`${JSON.stringify(plan.settings, null, 2)}\n`),
      );
    else
      change(
        step.path,
        plan.files.find((file) => file.path === step.path)!.content,
      );
  }
  // nodrail owns what it writes, and what it owned already: never a file
  // that merely matched, which is the person's and must never be removed.
  const owned = (path: string) => {
    const step = plan.steps.find((each) => each.path === path);
    return (
      step?.action === "create" ||
      step?.action === "update" ||
      (step?.action === "keep" && plan.state?.files[path] !== undefined)
    );
  };
  const state: SetupState = {
    state: 1,
    runtime: plan.runtime,
    files: Object.fromEntries(
      plan.files
        .filter((file) => owned(file.path))
        .map((file) => [file.path, sha256(file.content)]),
    ),
    // Only Claude Code's settings are shared with the person's own.
    settings: plan.runtime === "claude-code" ? { agent: plan.entry } : {},
  };
  const text = Buffer.from(`${JSON.stringify(state, null, 2)}\n`);
  if (onDisk(root, STATE_FILE) !== sha256(text)) change(STATE_FILE, text);
  return { entries, contents };
}

/**
 * Applies a reviewed plan as the project's only writer. It plans again
 * inside the hold and refuses if anything differs from what was reviewed.
 * The changes are journaled first, so a stop partway is finished by the next
 * nodrail, and a file someone changes meanwhile is left alone and named.
 */
export function applySetup(place: Place & { env: Env }, reviewed: SetupPlan) {
  const left = holdProject(place, (folder) => {
    const now = planSetup({ ...place, held: true });
    if (fingerprint(now) !== fingerprint(reviewed))
      throw new CliError(
        "The project changed after the plan was shown. Nothing was changed; run `nodrail apply` again to see the new plan.",
      );
    const { entries, contents } = journalFor(place.root, now);
    if (entries.length === 0) return [];
    stageJournal(folder, entries, contents);
    return replayJournal(place.root, folder) ?? [];
  });
  if (left.length > 0)
    throw new CliError(
      [
        "These changed while applying and were left as they are:",
        ...left.map((path) => `  ${path}`),
        "Run `nodrail plan` to see where things stand.",
      ].join("\n"),
    );
}
