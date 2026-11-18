import { execFileSync } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { ProjectSetup } from "@nodrail/policy-engine/yaml";
import { frozenPolicy, setupOf } from "../commands/project.ts";
import type { Env } from "../config.ts";
import { CliError } from "../io.ts";
import { folderHost } from "../project/host.ts";
import { MANIFEST_FILE, sha256 } from "../project/lockfile.ts";
import { planProject, readProject } from "../project/project.ts";
import { codexSetup, MIN_CODEX } from "./codex.ts";
import {
  claudeCodeSetup,
  HOOK_PREFIX,
  MIN_CLAUDE,
  SETTINGS_FILE,
  type DesiredFile,
  type DesiredSettings,
} from "./claude-code.ts";
import { readState, STATE_FILE, type SetupState } from "./state.ts";

export type StepAction = "create" | "update" | "keep" | "remove" | "conflict";
/** One file and what apply would do to it. */
export type Step = { path: string; action: StepAction; why: string };
/** Something the host needs, and whether it's there. */
export type Check = { name: string; ok: boolean; detail: string };

export type SetupPlan = {
  runtime: "claude-code" | "codex";
  team: string;
  entry: string;
  /** Whether nodrail.yaml asks to start the host once it is set up. */
  start: boolean;
  checks: Check[];
  steps: Step[];
  /** Why apply can't go ahead, beyond a failed check or a conflict. */
  problems: string[];
  notes: string[];
  /** What apply would write, in the order of `steps`. */
  files: DesiredFile[];
  settings: Record<string, unknown> | null;
  state: SetupState | null;
};

/** Whether apply could go ahead: every check passes, nothing conflicts. */
export const isReady = (plan: SetupPlan) =>
  plan.problems.length === 0 &&
  plan.checks.every((check) => check.ok) &&
  plan.steps.every((step) => step.action !== "conflict");

/**
 * What `nodrail apply` would do here, found by reading only: the files the
 * host needs, compared with the disk and with what nodrail wrote before, and
 * the tools it needs, looked for on PATH.
 */
export function planSetup(input: {
  root: string;
  home: string;
  env: Env;
  /** Planned by `apply` while it holds the project. */
  held?: boolean;
}): SetupPlan {
  const { root } = input;
  const checks: Check[] = [];
  const policy = lockedPolicy(input, checks);
  const { setup } = policy;
  if (setup.runtime === null)
    throw new CliError(
      `${MANIFEST_FILE} doesn't say which host to set up. Add runtime: claude-code.`,
    );
  if (setup.team === null)
    throw new CliError(`${MANIFEST_FILE} has no Team to start.`);
  const base = {
    runtime: setup.runtime,
    team: setup.team.name,
    entry: setup.team.entry,
    start: setup.start,
    checks,
    state: readState(root),
  };
  const effective = policy.text ?? "";
  const nodrail = onPath("nodrail", input.env, "the policy hook runs it");
  const host =
    setup.runtime === "codex"
      ? {
          ...codexSetup({ root, setup, effective, inputs: policy.inputs }),
          settings: null,
          check: versionCheck("codex", MIN_CODEX, "install Codex", input.env),
        }
      : {
          ...claudeCodeSetup({ root, setup, effective, inputs: policy.inputs }),
          check: versionCheck(
            "claude",
            MIN_CLAUDE,
            "install Claude Code",
            input.env,
          ),
        };
  checks.push(host.check, nodrail);
  // Without a locked policy there is none to write.
  const files =
    policy.text === null
      ? host.files.filter((file) => !file.path.startsWith(".nodrail/"))
      : host.files;
  const steps = files.map((file) => fileStep(root, base.state, file));
  for (const [path, hash] of Object.entries(base.state?.files ?? {}))
    if (!files.some((file) => file.path === path))
      steps.push(goneStep(root, path, hash));
  let settings: Record<string, unknown> | null = null;
  if (host.settings) {
    const step = settingsStep(root, base.state, host.settings);
    steps.push(step.step);
    settings = step.value;
  }
  return {
    ...base,
    steps,
    problems: host.problems,
    notes: [
      ...host.skipped.map(
        (name) =>
          `Agent ${name} isn't on team ${setup.team!.name}; it isn't set up.`,
      ),
      `apply records what it writes in ${STATE_FILE}.`,
    ],
    files,
    settings,
  };
}

/** The locked policy, or the setup alone with a failed check saying why. */
function lockedPolicy(
  input: { root: string; home: string; held?: boolean },
  checks: Check[],
): { text: string | null; setup: ProjectSetup; inputs: string[] } {
  try {
    const frozen = frozenPolicy(input);
    checks.push({
      name: "policy",
      ok: true,
      detail: "matches nodrail.lock.yaml",
    });
    return frozen;
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    const project = readProject(input.root);
    if (project.manifest === null) throw error;
    checks.push({ name: "policy", ok: false, detail: error.message });
    const plan = planProject({
      root: input.root,
      manifest: project.manifest,
      previous: project.lock,
    });
    return { text: null, ...setupOf(plan) };
  }
}

/** The file's bytes, null when there is none, "folder" when a folder is. */
function readBytes(root: string, path: string): Buffer | null | "folder" {
  try {
    return readFileSync(join(root, path));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    if (code === "EISDIR") return "folder";
    throw error;
  }
}

function fileStep(
  root: string,
  state: SetupState | null,
  file: DesiredFile,
): Step {
  const { path, why } = file;
  // Never through a link: it could lead to a file outside the project.
  if (folderHost(root).real(path) !== path)
    return {
      path,
      action: "conflict",
      why: `${why}; the path goes through a link`,
    };
  const disk = readBytes(root, path);
  if (disk === null) return { path, action: "create", why };
  if (disk === "folder")
    return { path, action: "conflict", why: `${why}; a folder is there` };
  const now = sha256(disk);
  if (now === sha256(file.content)) return { path, action: "keep", why };
  const written = state?.files[path];
  if (written === undefined)
    return {
      path,
      action: "conflict",
      why: `${why}; already there, not written by nodrail`,
    };
  if (written !== now)
    return {
      path,
      action: "conflict",
      why: `${why}; edited since nodrail wrote it`,
    };
  return { path, action: "update", why };
}

function goneStep(root: string, path: string, hash: string): Step {
  const disk = readBytes(root, path);
  if (disk === null) return { path, action: "keep", why: "already removed" };
  if (disk === "folder" || sha256(disk) !== hash)
    return {
      path,
      action: "conflict",
      why: "no longer needed, but edited since nodrail wrote it",
    };
  return { path, action: "remove", why: "no longer needed" };
}

/**
 * Claude Code's settings with nodrail's entries set and everything else kept:
 * `agent`, and one PreToolUse hook found by its command.
 */
function settingsStep(
  root: string,
  state: SetupState | null,
  want: DesiredSettings,
): { step: Step; value: Record<string, unknown> | null } {
  const path = SETTINGS_FILE;
  const why = `start as ${want.agent}; the policy hook`;
  const read = readSettings(root, path);
  const refusal =
    typeof read === "string"
      ? read
      : settingsRefusal(read.current, state, want);
  if (refusal !== null || typeof read === "string")
    return {
      step: { path, action: "conflict", why: `${why}; ${refusal}` },
      value: null,
    };
  const { disk, current } = read;
  const hooks = (current.hooks ?? {}) as Record<string, unknown>;
  const groups = Array.isArray(hooks.PreToolUse)
    ? (hooks.PreToolUse as unknown[])
    : [];
  const value = {
    ...current,
    agent: want.agent,
    hooks: { ...hooks, PreToolUse: [...withoutOurs(groups), want.hook] },
  };
  const action: StepAction =
    disk === null
      ? "create"
      : JSON.stringify(value) === JSON.stringify(current)
        ? "keep"
        : "update";
  return { step: { path, action, why }, value };
}

/**
 * Claude Code's settings as they are, or why nodrail can't edit them: a link,
 * as in a dotfiles setup, which writing would replace; or not a JSON object.
 */
function readSettings(root: string, path: string) {
  if (folderHost(root).real(path) !== path)
    return "the path goes through a link";
  const disk = readBytes(root, path);
  if (disk === null) return { disk, current: {} as Record<string, unknown> };
  try {
    if (disk === "folder") throw new Error("a folder");
    const parsed: unknown = JSON.parse(disk.toString("utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("not an object");
    return { disk, current: parsed as Record<string, unknown> };
  } catch {
    return "it isn't a JSON object";
  }
}

/** Why settings that read fine still can't take nodrail's entries, or null. */
function settingsRefusal(
  current: Record<string, unknown>,
  state: SetupState | null,
  want: DesiredSettings,
) {
  if (
    current.agent !== undefined &&
    current.agent !== want.agent &&
    current.agent !== state?.settings.agent
  )
    return `agent is set to ${JSON.stringify(current.agent)}, not by nodrail`;
  if (current.disableAllHooks === true)
    return "disableAllHooks is on, so no hook would run";
  return null;
}

const isOurs = (hook: unknown) =>
  typeof hook === "object" &&
  hook !== null &&
  typeof (hook as { command?: unknown }).command === "string" &&
  (hook as { command: string }).command.startsWith(HOOK_PREFIX);

/**
 * The hook groups with nodrail's own hooks taken out, and a group left empty
 * by that dropped. Everyone else's hooks stay where they were.
 */
function withoutOurs(groups: unknown[]) {
  return groups.flatMap((group) => {
    const inner = (group as { hooks?: unknown }).hooks;
    if (!Array.isArray(inner) || !inner.some(isOurs)) return [group];
    const rest = inner.filter((hook) => !isOurs(hook));
    return rest.length > 0 ? [{ ...(group as object), hooks: rest }] : [];
  });
}

const windows = process.platform === "win32";

/** The first executable called `name` on PATH, or null; on Windows, with PATHEXT. */
export function findOnPath(name: string, env: Env) {
  const endings = windows
    ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  for (const folder of (env.PATH ?? env.Path ?? "")
    .split(delimiter)
    .filter(Boolean))
    for (const ending of endings) {
      const path = join(folder, name + ending);
      try {
        accessSync(path, constants.X_OK);
        return path;
      } catch {
        // Not here.
      }
    }
  return null;
}

function onPath(name: string, env: Env, why: string): Check {
  const path = findOnPath(name, env);
  return path
    ? { name, ok: true, detail: path }
    : { name, ok: false, detail: `not on PATH; ${why}` };
}

const parts = (version: string) => version.split(".").map(Number);
export function atLeast(version: string, minimum: string) {
  const [a, b] = [parts(version), parts(minimum)];
  for (let index = 0; index < 3; index++)
    if ((a[index] ?? 0) !== (b[index] ?? 0))
      return (a[index] ?? 0) > (b[index] ?? 0);
  return true;
}

/** A tool on PATH at `minimum` or later, by its `--version`. */
function versionCheck(
  name: string,
  minimum: string,
  install: string,
  env: Env,
): Check {
  const path = findOnPath(name, env);
  if (path === null)
    return { name, ok: false, detail: `not on PATH; ${install}` };
  let output = "";
  try {
    output = execFileSync(windows ? `"${path}"` : path, ["--version"], {
      encoding: "utf8",
      env: env as NodeJS.ProcessEnv,
      timeout: 15_000,
      stdio: ["ignore", "pipe", "ignore"],
      // A .cmd runs only through the shell; the arguments are fixed.
      shell: windows,
    });
  } catch {
    return { name, ok: false, detail: `${path} --version failed` };
  }
  const version = /\d+\.\d+\.\d+/.exec(output)?.[0];
  if (!version)
    return { name, ok: false, detail: `unexpected version: ${output.trim()}` };
  return atLeast(version, minimum)
    ? { name, ok: true, detail: version }
    : { name, ok: false, detail: `${version}; needs ${minimum} or later` };
}
