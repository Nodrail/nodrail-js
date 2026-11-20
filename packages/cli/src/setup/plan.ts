import { HOST_NAMES } from "./state.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ProjectSetup,
  SetupConnection,
} from "@nodrail/policy-engine/yaml";
import { frozenPolicy, setupOf } from "../commands/project.ts";
import type { Env } from "../config.ts";
import { CliError } from "../io.ts";
import { folderHost } from "../project/host.ts";
import { MANIFEST_FILE, sha256 } from "../project/lockfile.ts";
import { planProject, readProject } from "../project/project.ts";
import { codexSetup, MIN_CODEX } from "./codex.ts";
import { copilotHookChecks, copilotSetup, MIN_COPILOT } from "./copilot.ts";
import { onPath, versionCheck } from "./tools.ts";

export { atLeast, findOnPath } from "./tools.ts";
import {
  claudeCodeSetup,
  EFFECTIVE_FILE,
  MIN_CLAUDE,
  type DesiredFile,
  type DesiredSettings,
} from "./claude-code.ts";
import { claudeSteps } from "./claude-settings.ts";
import { managedChecks } from "./managed.ts";
import { goneDataNotes, pinChecks, telemetryNote } from "./connections.ts";
import { runningHere, testedCheck } from "./tested.ts";
import {
  claudePluginNote,
  codexInstallChecks,
  originChecks,
} from "./plugins.ts";
import {
  lockedRevision,
  missingStateNote,
  otherHostNotes,
  type Revision,
} from "./status.ts";
import {
  hostState,
  otherOwners,
  readState,
  STATE_FILE,
  type Runtime,
  type SetupState,
} from "./state.ts";

export type StepAction = "create" | "update" | "keep" | "remove" | "conflict";
/** One file and what apply would do to it. */
export type Step = { path: string; action: StepAction; why: string };
/** Something the host needs, and whether it's there. */
/**
 * A check `plan` shows. One not ok blocks; one unverified doesn't, but says
 * what wasn't proven here.
 */
export type Check = {
  name: string;
  ok: boolean;
  detail: string;
  unverified?: boolean;
};

export type SetupPlan = {
  runtime: Runtime;
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
  /** Files shared with the person's own entries, as apply would write them. */
  merged: Record<string, Record<string, unknown>>;
  /** The tool connections, for the checks that start them. */
  connections: SetupConnection[];
  /** Where decisions are sent, for the secret checks and the status. */
  telemetry: ProjectSetup["telemetry"];
  state: SetupState | null;
  /** The reviewed revision the setup is made from, as the lock records it. */
  revision: Revision;
  /** Claude Code: the marketplaces and plugins its settings switch on. */
  claudePlugins: { marketplaces: string[]; enabled: string[] };
  /** The setup's plugins, for the hook command and the checks. */
  plugins: ProjectSetup["plugins"];
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
  /** The host `--runtime` names, when nodrail.yaml lists more than one. */
  runtime?: string;
  /** Where an administrator's files are, for tests: by default, the system's. */
  managed?: { claude?: string; codex?: string; profile?: string };
}): SetupPlan {
  const { root } = input;
  const checks: Check[] = [];
  const policy = lockedPolicy(input, checks);
  const { setup } = policy;
  const runtime = chooseRuntime(setup.runtimes, input.runtime);
  if (setup.team === null)
    throw new CliError(`${MANIFEST_FILE} has no Team to start.`);
  const base = {
    runtime,
    team: setup.team.name,
    entry: setup.team.entry,
    start: setup.start,
    checks,
    state: readState(root),
    revision: lockedRevision(root),
  };
  const effective = policy.text ?? "";
  const host = hostSetup(runtime, {
    root,
    setup,
    effective,
    inputs: policy.inputs,
    env: input.env,
  });
  checks.push(...hostChecks(input, runtime, setup, host.check));
  checks.push(
    ...managedChecks(runtime, {
      root,
      setup,
      settings: host.settings,
      managed: input.managed,
    }),
  );
  // Without a locked policy there is none to write.
  const files =
    policy.text === null
      ? host.files.filter((file) => !file.path.startsWith(".nodrail/"))
      : host.files;
  const owner = { state: base.state, runtime };
  const steps = files.map((file) => fileStep(root, owner, file));
  for (const [path, hash] of Object.entries(
    hostState(base.state, runtime)?.files ?? {},
  ))
    if (!files.some((file) => file.path === path))
      steps.push(goneStep(root, owner, path, hash));
  const merged: Record<string, Record<string, unknown>> = {};
  if (host.settings)
    for (const { step, value } of claudeSteps(
      root,
      hostState(base.state, runtime)?.settings,
      host.settings,
    )) {
      steps.push(step);
      if (value) merged[step.path] = value;
    }
  return {
    ...base,
    steps,
    problems: host.problems,
    notes: [
      ...notesFor(input.home, root, setup, host.skipped),
      ...(runtime === "claude-code" ? claudePluginNote(setup) : []),
      ...stateNotes({ ...base, runtime }, steps),
      ...goneDataNotes(hostState(base.state, runtime)?.data, setup),
    ],
    files,
    merged,
    connections: setup.connections,
    telemetry: setup.telemetry,
    claudePlugins: pluginNames(host.settings),
    plugins: setup.plugins,
  };
}

/** What the host needs, and whether its program is there. */
function hostSetup(
  runtime: Runtime,
  input: {
    root: string;
    setup: ProjectSetup;
    effective: string;
    inputs: string[];
    env: Env;
  },
) {
  const { env, ...rest } = input;
  if (runtime === "copilot")
    return {
      ...copilotSetup(rest),
      settings: null,
      check: versionCheck("copilot", MIN_COPILOT, "install Copilot CLI", env),
    };
  return runtime === "codex"
    ? {
        ...codexSetup(rest),
        settings: null,
        check: versionCheck("codex", MIN_CODEX, "install Codex", env),
      }
    : {
        ...claudeCodeSetup(rest),
        check: versionCheck("claude", MIN_CLAUDE, "install Claude Code", env),
      };
}

/** The host's checks: its program, nodrail, Codex's plugins, the profile. */
function hostChecks(
  input: { root: string; home: string; env: Env },
  runtime: Runtime,
  setup: ProjectSetup,
  host: Check,
) {
  return [
    host,
    onPath("nodrail", input.env, "the policy hook runs it"),
    ...(runtime === "copilot" ? copilotHookChecks(input) : []),
    ...(runtime === "codex"
      ? codexInstallChecks({
          root: input.root,
          setup,
          env: input.env,
          home: input.home,
        })
      : []),
    ...profileCheck(setup, runtime, host),
    ...pinChecks(setup),
    ...originChecks(setup),
  ];
}

/** Claude Code's marketplaces and plugins its settings switch on. */
const pluginNames = (settings: DesiredSettings | null) => ({
  marketplaces: Object.keys(settings?.plugins.marketplaces ?? {}),
  enabled: Object.keys(settings?.plugins.enabled ?? {}),
});

/** The tested-versions check, when nodrail.yaml names them. */
function profileCheck(setup: ProjectSetup, runtime: Runtime, host: Check) {
  const running = runningHere(runtime, host.ok ? host.detail : null);
  const tested = testedCheck(setup.tested, runtime, running);
  return tested ? [tested] : [];
}

/** What the plan says about the other host here, and a missing state. */
function stateNotes(
  base: { runtime: Runtime; state: SetupState | null; revision: Revision },
  steps: Step[],
) {
  return [
    ...otherHostNotes({
      ...base,
      policyChanges: steps.some(
        (step) => step.path === EFFECTIVE_FILE && step.action === "update",
      ),
    }),
    ...missingStateNote(
      base.state,
      steps
        .filter((step) => step.action === "conflict")
        .map((step) => step.path),
    ),
  ];
}

/** What the plan says beside its steps: who is left out, and telemetry. */
function notesFor(
  home: string,
  root: string,
  setup: ProjectSetup,
  skipped: string[],
) {
  const telemetry = telemetryNote(home, root, setup);
  return [
    ...skipped.map(
      (name) =>
        `Agent ${name} isn't on team ${setup.team!.name}; it isn't set up.`,
    ),
    `apply records what it writes in ${STATE_FILE}.`,
    ...(telemetry ? [telemetry] : []),
  ];
}

/**
 * The host to set up: the one nodrail.yaml names, or, when it lists both,
 * the one `--runtime` picks. A host it doesn't list is refused.
 */
export function chooseRuntime(
  listed: readonly Runtime[],
  asked: string | undefined,
): Runtime {
  if (listed.length === 0)
    throw new CliError(
      `${MANIFEST_FILE} doesn't say which host to set up. Add runtime: claude-code, runtime: codex, or runtimes: [claude-code, codex].`,
    );
  if (asked === undefined) {
    if (listed.length === 1) return listed[0]!;
    throw new CliError(
      `${MANIFEST_FILE} sets up ${listed.map((name) => HOST_NAMES[name]).join(" and ")}: say which with ${listed.map((name) => `--runtime ${name}`).join(" or ")}.`,
    );
  }
  const found = listed.find((name) => name === asked);
  if (found === undefined)
    throw new CliError(
      `${MANIFEST_FILE} doesn't set up ${asked}; it lists ${listed.join(", ")}.`,
    );
  return found;
}

/** The locked policy, or the setup alone with a failed check saying why. */
function lockedPolicy(
  input: { root: string; home: string; held?: boolean },
  checks: Check[],
): { text: string | null; setup: ProjectSetup; inputs: string[] } {
  try {
    const { workspace, ...frozen } = frozenPolicy(input);
    checks.push({
      name: "policy",
      ok: true,
      detail: "matches nodrail.lock.yaml",
    });
    if (workspace) checks.push({ name: "workspace", ...workspace });
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
export function readBytes(
  root: string,
  path: string,
): Buffer | null | "folder" {
  try {
    return readFileSync(join(root, path));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    if (code === "EISDIR") return "folder";
    throw error;
  }
}

/** The state, and the host whose files a step is about. */
type Owner = { state: SetupState | null; runtime: Runtime };

function fileStep(root: string, owner: Owner, file: DesiredFile): Step {
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
  // A file both hosts need, last written for the other one, is nodrail's
  // too while it holds what was written.
  const written =
    hostState(owner.state, owner.runtime)?.files[path] ??
    otherOwners(owner.state, owner.runtime, path).find(
      (other) => other.hash === now,
    )?.hash;
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

function goneStep(
  root: string,
  owner: Owner,
  path: string,
  hash: string,
): Step {
  const others = otherOwners(owner.state, owner.runtime, path);
  if (others.length > 0)
    return {
      path,
      action: "keep",
      why: `no longer needed here; kept for ${others.map((other) => HOST_NAMES[other.host]).join(" and ")}`,
    };
  return removalStep(root, path, hash, {
    edited: "no longer needed, but edited since nodrail wrote it",
    removed: "no longer needed",
  });
}

/**
 * Taking out a file nodrail wrote: nothing to do when it's gone, and kept,
 * as a conflict, when it was edited since.
 */
export function removalStep(
  root: string,
  path: string,
  hash: string,
  why: { edited: string; removed: string },
): Step {
  const disk = readBytes(root, path);
  if (disk === null) return { path, action: "keep", why: "already removed" };
  if (disk === "folder" || sha256(disk) !== hash)
    return { path, action: "conflict", why: why.edited };
  return { path, action: "remove", why: why.removed };
}
