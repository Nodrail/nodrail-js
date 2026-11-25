import { HOST_NAMES } from "./state.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Env } from "../config.ts";
import { readLock, type Lock } from "../project/lockfile.ts";
import { claudeManaged, MANAGED_FOLDERS, pluginOnly } from "./managed.ts";
import { EFFECTIVE_FILE } from "./team-files.ts";
import type { Runtime, SetupState } from "./state.ts";

/**
 * Which reviewed revision a setup is made from: the policy's digest and the
 * whole workspace's, from nodrail.lock.yaml. Null where the lock has none.
 */
export type Revision = { policy: string | null; workspace: string | null };

/** The revision nodrail.lock.yaml records, as it is on disk. */
export function lockedRevision(root: string, proposed?: Lock): Revision {
  const lock = proposed ?? readLockedRevision(root);
  return typeof lock === "string"
    ? { policy: null, workspace: null }
    : {
        policy: lock.effective?.sha256 ?? null,
        workspace: lock.workspace?.sha256 ?? null,
      };
}

function readLockedRevision(root: string) {
  try {
    return readLock(readFileSync(join(root, "nodrail.lock.yaml"), "utf8"));
  } catch {
    return "";
  }
}

/**
 * Whether the host runs the policy hook here:
 * - `verified`: the host itself said it runs it (Codex, asked read-only);
 * - `configured`: the hook is in place and nothing known turns hooks off, but
 *   the host can't be asked (Claude Code runs project hooks without a trust
 *   step);
 * - `inactive`: it doesn't, and `detail` says what to do;
 * - `unknown`: it couldn't be told.
 */
export type ActivationState =
  "verified" | "configured" | "inactive" | "unknown";
export type Activation = { state: ActivationState; detail: string };

/** Whether the hook is configured and the host settings allow it to run. */
export const enforced = (activation: Activation) =>
  activation.state === "verified" || activation.state === "configured";

/** Render what the host has established, and how to observe real enforcement. */
export function hookStatus(active: Activation, connected: boolean) {
  if (active.state === "configured") {
    const proof = connected
      ? "Confirm it runs with the first-check decision in Agents → Connect a project."
      : "Start a host session and try a tool call covered by your policy to confirm.";
    return `Hook configured: ${active.detail}. ${proof}`;
  }
  if (active.state === "verified") return `Hook active: ${active.detail}.`;
  return `Hook status: ${active.detail}.`;
}

/** A settings file's JSON object, or null when there is none or it isn't one. */
function settingsAt(path: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * For Claude Code, which has no trust step and no way to list the hooks it
 * would run: the hook is configured, unless a settings file it reads turns
 * hooks off, or an administrator's allows only theirs or keeps hooks to
 * plugins.
 */
export function claudeActivation(input: {
  root: string;
  home: string;
  env: Env;
  /** The administrator's folder, for tests: by default, the system's. */
  managed?: string;
}): Activation {
  const user = input.env.CLAUDE_CONFIG_DIR ?? join(input.home, ".claude");
  for (const path of [
    join(user, "settings.json"),
    // The project's own, which plan also refuses to set up over.
    join(input.root, ".claude/settings.json"),
    join(input.root, ".claude/settings.local.json"),
  ])
    if (settingsAt(path)?.disableAllHooks === true)
      return {
        state: "inactive",
        detail: `${path} sets disableAllHooks, so no hook runs`,
      };
  const folder = input.managed ?? MANAGED_FOLDERS[process.platform]?.claude;
  const managed = claudeManaged(folder);
  const where = `${folder}'s managed settings`;
  if (managed?.disableAllHooks === true)
    return {
      state: "inactive",
      detail: `${where} set disableAllHooks, so no hook runs`,
    };
  if (managed?.allowManagedHooksOnly === true)
    return {
      state: "inactive",
      detail: `${where} allow only managed hooks, so the project's hook doesn't run`,
    };
  if (pluginOnly(managed, "hooks"))
    return {
      state: "inactive",
      detail: `${where} keep hooks to plugins (strictPluginOnlyCustomization), so the project's hook doesn't run`,
    };
  return {
    state: "configured",
    detail:
      "the hook is in .claude/settings.json and no settings file turns hooks off; Claude Code can't be asked which hooks it runs",
  };
}

/**
 * Notes for the other host set up in the same folder: it shares the policy
 * file, so a change to it reaches that host at its next tool call, while its
 * agents and skills stay as last applied for it.
 */
export function otherHostNotes(input: {
  runtime: Runtime;
  state: SetupState | null;
  policyChanges: boolean;
  revision: Revision;
}) {
  const notes: string[] = [];
  for (const [name, entry] of Object.entries(input.state?.hosts ?? {})) {
    const other = name as Runtime;
    if (other === input.runtime || !entry) continue;
    const host = HOST_NAMES[other];
    if (input.policyChanges && entry.files[EFFECTIVE_FILE] !== undefined)
      notes.push(
        `${host} is set up here too and reads the same policy: it enforces the new one from its next tool call, in sessions already open.`,
      );
    const applied = entry.revision?.workspace;
    if (
      input.revision.workspace !== null &&
      applied !== input.revision.workspace
    )
      notes.push(
        `${host}'s agents and skills are ${applied ? `from workspace ${applied.slice(0, 12)}` : "from before workspaces were recorded"}: run \`nodrail apply --runtime ${other}\` to bring them to ${input.revision.workspace.slice(0, 12)}.`,
      );
  }
  return notes;
}

/**
 * When the state is missing but nodrail's own folder isn't: whatever wrote
 * those files, nodrail won't take them for its own.
 */
export const missingStateNote = (
  state: SetupState | null,
  conflicted: string[],
) =>
  state === null && conflicted.some((path) => path.startsWith(".nodrail/"))
    ? [
        ".nodrail/setup-state.json is missing, so nodrail owns none of the files marked !. If an earlier apply wrote them, restore the state from a local backup; otherwise move them aside. Nothing is overwritten meanwhile.",
      ]
    : [];
