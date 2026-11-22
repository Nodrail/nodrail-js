import { HOST_NAMES } from "./state.ts";
import type {
  ProjectSetup,
  SetupConnection,
} from "@nodrail/policy-engine/yaml";
import { frozenPolicy, setupOf } from "../commands/project.ts";
import type { Env } from "../config.ts";
import { CliError } from "../io.ts";
import { LOCK_FILE, MANIFEST_FILE } from "../project/lockfile.ts";
import {
  bindingNotes,
  changeLines,
  contractChanges,
} from "../contracts/changes.ts";
import type { CompiledContracts } from "../contracts/engine.ts";
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
import { connectChecks, connectNotes } from "./connect.ts";
import { fileStep, goneStep } from "./steps.ts";
import { runningHere, testedCheck } from "./tested.ts";
import {
  claudePluginNote,
  codexInstallChecks,
  originChecks,
} from "./plugins.ts";
import { accountableHere, type Accountable } from "./accountable.ts";
import {
  lockedRevision,
  missingStateNote,
  otherHostNotes,
  type Revision,
} from "./status.ts";
import {
  hostState,
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
  /** The Nodrail the project is connected to, for the credential check. */
  connect: ProjectSetup["connect"];
  /** The project's stable id, which a published policy is tied to. */
  projectId: ProjectSetup["id"];
  state: SetupState | null;
  /** The reviewed revision the setup is made from, as the lock records it. */
  revision: Revision;
  /** Claude Code: the marketplaces and plugins its settings switch on. */
  claudePlugins: { marketplaces: string[]; enabled: string[] };
  /** The setup's plugins, for the hook command and the checks. */
  plugins: ProjectSetup["plugins"];
  /** Numeric budgets and evidence requirements (engine level 5), as enforced here. */
  accountable: Accountable;
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
  const host = hostSetup(runtime, { ...input, ...policy, effective });
  checks.push(...hostChecks(input, runtime, setup, host.check));
  checks.push(...connectChecks(setup, runtime));
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
  const level5 = accountableHere(input, runtime, effective, files);
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
    problems: [...host.problems, ...level5.problems],
    notes: [
      ...notesFor(input.home, root, setup, host.skipped),
      ...(runtime === "claude-code" ? claudePluginNote(setup) : []),
      ...stateNotes({ ...base, runtime }, steps),
      ...goneDataNotes(hostState(base.state, runtime)?.data, setup),
      ...policy.contractNotes,
    ],
    files,
    merged,
    connections: setup.connections,
    telemetry: setup.telemetry,
    connect: setup.connect,
    projectId: setup.id,
    claudePlugins: pluginNames(host.settings),
    plugins: setup.plugins,
    accountable: level5,
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
    contracts: CompiledContracts | null;
    env: Env;
  },
) {
  const { env } = input;
  if (runtime === "copilot")
    return {
      ...copilotSetup(input),
      settings: null,
      check: versionCheck("copilot", MIN_COPILOT, "install Copilot CLI", env),
    };
  return runtime === "codex"
    ? {
        ...codexSetup(input),
        settings: null,
        check: versionCheck("codex", MIN_CODEX, "install Codex", env),
      }
    : {
        ...claudeCodeSetup(input),
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
    ...connectNotes(setup),
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
): {
  text: string | null;
  setup: ProjectSetup;
  inputs: string[];
  contracts: CompiledContracts | null;
  /** Each agent's contracts, and how they differ from an out-of-date lock. */
  contractNotes: string[];
} {
  try {
    const { workspace, ...frozen } = frozenPolicy(input);
    checks.push({
      name: "policy",
      ok: true,
      detail: "matches nodrail.lock.yaml",
    });
    if (workspace) checks.push({ name: "workspace", ...workspace });
    return { ...frozen, contractNotes: bindingNotes(frozen) };
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
    const contractNotes = [
      ...bindingNotes(setupOf(plan)),
      ...changeLines(
        contractChanges(
          project.lock?.contractsBaseline ?? null,
          plan.contracts,
        ),
        LOCK_FILE,
      ),
    ];
    return { text: null, ...setupOf(plan), contractNotes };
  }
}
