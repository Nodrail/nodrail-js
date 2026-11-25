import { allowQuietly, deny, type HookResult } from "./actions.ts";
import { readHookConnection, type HookConnection } from "./hook-connection.ts";
import { loadHookPolicy, type HookPolicy } from "./hook-policy.ts";
import { budgetExecution } from "./hook-budget-execution.ts";
import type { ConnectionCalls } from "./connections.ts";
import {
  claudeAnswerFor,
  copilotAnswer,
  copilotEvents,
  copilotFromClaude,
  copilotRefusal,
  copilotSettleEvent,
  copilotStepEvent,
} from "./copilot-hook.ts";
import { hookEvidence } from "./hook-evidence.ts";
import { hookIsStep } from "./hook-guard.ts";
import { hostName, reporterOf, sinkOf } from "./hook-reporting.ts";
import { policyDigestWarning } from "./hook-policy-digest.ts";
import { told, type Observed } from "./hook-telemetry.ts";
import { decideToolCall, toolIntegrity } from "./local-hook.ts";
import type { PolicyDocument } from "./policies.ts";
import type { Environment } from "./run-key.ts";
import { hookGuards, type Guards } from "./hook-setup.ts";
import { protectedPaths } from "./rules-guard.ts";
import { runHook, runOutcome } from "./run-hook.ts";
import { recordWatchFailure } from "./watch-audit.ts";

/**
 * `nodrail-policy hook`: one host's tool call on stdin, judged by the rules,
 * answered in the host's own shape. Claude Code and Codex send the same
 * event; Copilot's is read as the Claude Code calls it is.
 */

export type HookRun = {
  values: {
    agent?: string;
    installation?: string;
    unmatched?: string;
    "protect-list"?: string;
    connections?: string;
    telemetry?: string;
    /** `{ url, credential }`: record each decision and outcome in Nodrail. */
    report?: string;
    connect?: string;
    "legacy-connect"?: boolean;
    host?: string;
    /** `{ url, workspace_revision }` for externally verified evidence; token from NODRAIL_TOKEN. */
    evidence?: string;
  };
  document: PolicyDocument;
  policyDigest?: string | null;
  now: Date;
  paths: string[];
};

export type HookIo = {
  /** COPILOT_HOOK_DEPTH says Copilot runs this hook. */
  env?: Record<string, string | undefined>;
  readStdin(): Promise<string>;
  write(text: string): void;
  writeError(text: string): void;
  self?: readonly string[];
  home?: string;
  fetch?: typeof fetch;
};

const identityOf = (values: HookRun["values"]) => ({
  agent: values.agent,
  installation: values.installation,
});

type PrepareTool = (event: string) => Promise<() => HookResult>;

/** Read remote conditions together, then judge the patch's parts in host order. */
async function copilotHook(
  stdin: string,
  connections: ConnectionCalls | null,
  prepare: PrepareTool,
) {
  const events = copilotEvents(stdin, Object.keys(connections ?? {}));
  if (typeof events === "string") return copilotRefusal(events);
  const prepared = await Promise.all(events.map(prepare));
  return copilotAnswer(prepared.map((judge) => judge()));
}

function hookOptions(run: HookRun, guards: Guards) {
  const { values, document, now, paths } = run;
  return {
    document,
    now,
    protect: [...protectedPaths(paths), ...(guards.setup?.paths ?? [])],
    ...guards,
    host:
      values.host === "codex" ? ("codex" as const) : ("claude-code" as const),
    unmatched:
      values.unmatched === "allow" ? ("allow" as const) : ("deny" as const),
    ...identityOf(values),
  };
}

/** PostToolUse and PostToolUseFailure: a call's outcome, never judged. */
function isOutcome(stdin: string) {
  try {
    const name = (JSON.parse(stdin) as { hook_event_name?: unknown })
      .hook_event_name;
    return name === "PostToolUse" || name === "PostToolUseFailure";
  } catch {
    return false;
  }
}

/** Copilot also runs Claude Code's hooks: the call is Copilot's then. */
function copilotMode(host: string | undefined, env: Record<string, unknown>) {
  if (host === "copilot") return "own" as const;
  return env.COPILOT_HOOK_DEPTH !== undefined &&
    hostName(host) === "claude-code"
    ? ("as-claude" as const)
    : null;
}

function answer(io: HookIo, result: HookResult) {
  if (result.stdout) io.write(result.stdout);
  if (result.stderr) io.writeError(result.stderr);
  return result.exitCode;
}

function hostEvent(stdin: string, host: string | undefined, env: Environment) {
  const copilot = copilotMode(host, env);
  return {
    stdin,
    copilot,
    step:
      copilotStepEvent(stdin) ??
      (copilot ? copilotSettleEvent(stdin) : isOutcome(stdin) ? stdin : null),
  };
}

function hookRefusal(event: ReturnType<typeof hostEvent>, reason: string) {
  if (event.step) return { ...allowQuietly, stderr: reason };
  return event.copilot === "own"
    ? copilotRefusal(reason.trim())
    : deny(reason.trim());
}

type HostEvent = ReturnType<typeof hostEvent>;
type RepositoryPolicy = {
  document: PolicyDocument;
  policyDigest: string | null;
};
type LoadRepositoryPolicy = () => Promise<RepositoryPolicy | null>;

async function decideForHost(
  event: HostEvent,
  connections: ConnectionCalls | null,
  prepare: PrepareTool,
  finish = (result: HookResult, _copilot: boolean) => result,
) {
  const { stdin, copilot } = event;
  if (!copilot) return finish((await prepare(stdin))(), false);
  const copilotInput = copilot === "own" ? stdin : copilotFromClaude(stdin);
  const result = finish(
    await copilotHook(copilotInput, connections, prepare),
    true,
  );
  return copilot === "own" ? result : claudeAnswerFor(result);
}

const emptyPolicy: PolicyDocument = { version: 1, rules: [] };

async function watchFailure(
  run: Omit<HookRun, "document">,
  io: HookIo,
  failure: { event: HostEvent; guards: Guards; reason: string },
) {
  const { event, guards, reason } = failure;
  recordWatchFailure({
    file: run.values.connect!,
    home: io.home,
    host: event.copilot ? "copilot" : hostName(run.values.host),
    stdin: event.step ?? event.stdin,
    now: run.now,
    reason,
    warn: (text) => io.writeError(text),
  });
  const base = hookOptions({ ...run, document: emptyPolicy }, guards);
  const result = event.step
    ? allowQuietly
    : await decideForHost(
        event,
        guards.connections,
        async (stdin) => () => toolIntegrity(stdin, base) ?? allowQuietly,
      );
  return answer(io, { ...result, stderr: reason + result.stderr });
}

const invalidConnection =
  "Nodrail: the repository lock differs from the applied policy or the hook configuration is invalid. Run nodrail apply again.\n";

export async function hookCommand(
  input: Omit<HookRun, "document">,
  io: HookIo,
  local: LoadRepositoryPolicy,
) {
  const env = io.env ?? process.env;
  const event = hostEvent(await io.readStdin(), input.values.host, env);
  if (event.step) hookIsStep();
  const { settings, error } = connectionFor(input.values);
  if (event.step && isOutcome(event.step)) {
    if (error) io.writeError(error);
    return finishOutcome(input, io, {
      event: event.step,
      copilot: !!event.copilot,
      settings,
      env,
    });
  }
  if (error) return answer(io, hookRefusal(event, error));
  return resolveAndEvaluate(input, io, local, { env, event, settings });
}

function connectionFor(values: HookRun["values"]) {
  try {
    const settings = values.connect
      ? readHookConnection(values.connect, values["legacy-connect"])
      : null;
    return { settings, error: null };
  } catch {
    return { settings: null, error: invalidConnection };
  }
}

async function resolveAndEvaluate(
  input: Omit<HookRun, "document">,
  io: HookIo,
  local: LoadRepositoryPolicy,
  context: {
    env: Environment;
    event: HostEvent;
    settings: HookConnection | null;
  },
) {
  const { event, env, settings } = context;
  const { guards, error } = hookGuards(
    input.values,
    event.step ?? event.stdin,
    env,
    io.home,
  );
  const watch = settings?.enforce === "watch";
  const failure = (reason: string, reply: () => number) =>
    watch ? watchFailure(input, io, { event, guards, reason }) : reply();
  const warning = (reason: string) => () => {
    io.writeError(reason);
    return event.step ? 0 : 2;
  };
  if (error) return failure(error, warning(error));

  const file = input.values.connect;
  const connected =
    file && settings ? await loadHookPolicy(file, settings, env, io) : null;
  if (typeof connected === "string")
    return failure(connected, () => answer(io, hookRefusal(event, connected)));
  const policy = await effectivePolicy(connected, local, io, watch);
  if (!policy) {
    const reason = "Nodrail: the hook has no repository policy.\n";
    return failure(reason, warning(reason));
  }
  const run: HookRun = {
    ...input,
    ...policy,
    values: event.copilot ? { ...input.values, host: "copilot" } : input.values,
  };
  return evaluateHook(run, io, { env, event, guards, connected, settings });
}

async function effectivePolicy(
  connected: HookPolicy | null,
  local: LoadRepositoryPolicy,
  io: HookIo,
  watch: boolean,
): Promise<RepositoryPolicy | null> {
  if (connected?.document)
    return {
      document: connected.document,
      policyDigest: connected.digest ?? null,
    };
  try {
    return await local();
  } catch (error) {
    if (!watch) throw error;
    io.writeError(`Nodrail: ${(error as Error).message}\n`);
    return null;
  }
}

function finishOutcome(
  input: Omit<HookRun, "document">,
  io: HookIo,
  context: {
    event: string;
    copilot: boolean;
    settings: HookConnection | null;
    env: Environment;
  },
) {
  const { settings, copilot, event, env } = context;
  const run: HookRun = {
    ...input,
    document: emptyPolicy,
    policyDigest:
      settings?.decide === "cloud" ? settings.policy_digest : undefined,
    values: copilot ? { ...input.values, host: "copilot" } : input.values,
  };
  const sink = sinkOf(run, io, settings);
  sink?.outcome(event);
  const { report } = reporterOf(run, io, sink);
  return answer(
    io,
    runOutcome(
      event,
      {
        now: run.now,
        report,
        host: run.values.host === "codex" ? "codex" : "claude-code",
        keyHost: copilot ? "copilot" : undefined,
      },
      env,
    ),
  );
}

function warnPolicySkew(run: HookRun, io: HookIo) {
  if (run.values.report && run.policyDigest && run.paths[0]) {
    const warning = policyDigestWarning(run.paths[0], run.policyDigest);
    if (warning) io.writeError(warning);
  }
}

async function evaluateHook(
  run: HookRun,
  io: HookIo,
  input: {
    env: Environment;
    event: ReturnType<typeof hostEvent>;
    guards: Guards;
    connected: HookPolicy | null;
    settings: HookConnection | null;
  },
) {
  const {
    env,
    event: { step, copilot },
    guards,
    connected,
  } = input;
  const sink = sinkOf(run, io, input.settings, connected?.evidence?.token);
  warnPolicySkew(run, io);
  const base = {
    ...hookOptions(run, guards),
    ...reporterOf(run, io, sink),
    ...(copilot ? { keyHost: "copilot" } : {}),
  };
  const runs =
    run.document.version !== 1 ||
    connected?.digest !== undefined ||
    connected?.watch === true;
  if (step) return answer(io, runs ? runHook(step, base, env) : allowQuietly);
  const watch = connected?.watch === true;
  const execution = budgetExecution(watch ? null : sink, {
    env,
    policyDigest: run.policyDigest ?? null,
    fetch: io.fetch,
  });
  const notices: Observed[] = [];
  const prepare: PrepareTool = async (event) => {
    const integrity = watch ? toolIntegrity(event, base) : null;
    const evidence = integrity
      ? null
      : await hookEvidence(event, base, {
          env,
          file: run.values.evidence,
          config: connected ? connected.evidence : undefined,
        });
    const options = await execution.prepare(event, {
      ...base,
      evidence,
      observe: copilot ? (item) => notices.push(item) : base.observe,
    });
    return () => {
      const result = runs
        ? runHook(event, options, env)
        : decideToolCall(event, options);
      return watch
        ? { ...(integrity ?? allowQuietly), stderr: result.stderr }
        : result;
    };
  };
  return answer(
    io,
    await decideForHost(
      input.event,
      guards.connections,
      prepare,
      (result, patch) => {
        const final = execution.finish(result, patch);
        for (const item of notices)
          base.observe?.(
            final.stdout && told(item.judged) === "allow"
              ? deniedPatch(item, final)
              : item,
          );
        return final;
      },
    ),
  );
}

function deniedPatch(item: Observed, result: HookResult): Observed {
  const { decision } = item.judged;
  return {
    ...item,
    judged: {
      ...item.judged,
      result,
      decision: decision && {
        ...decision,
        outcome: "deny",
        matchedRuleId: null,
        explanation: "Another change in the same Copilot patch was denied.",
      },
    },
  };
}
