import { accessChecks } from "./hook-access.ts";
import { allowQuietly, type HookResult } from "./actions.ts";
import type { HookIo, HookRun } from "./hook-command.ts";
import type { HookConnection } from "./hook-connection.ts";
import type { HookPolicy } from "./hook-policy.ts";
import {
  answer,
  decideForHost,
  type HostEvent,
  type PrepareTool,
} from "./hook-host-event.ts";
import { budgetExecution } from "./hook-budget-execution.ts";
import { hookEvidence } from "./hook-evidence.ts";
import { reporterOf, sinkOf } from "./hook-reporting.ts";
import { policyDigestWarning } from "./hook-policy-digest.ts";
import { told, type Observed } from "./hook-telemetry.ts";
import {
  decideToolCall,
  toolIntegrity,
  type LocalHookOptions,
} from "./local-hook.ts";
import type { Environment } from "./run-key.ts";
import type { Guards } from "./hook-setup.ts";
import { protectedPaths } from "./rules-guard.ts";
import { runHook } from "./run-hook.ts";

const identityOf = (values: HookRun["values"]) => ({
  agent: values.agent,
  installation: values.installation,
});

export function hookOptions(run: HookRun, guards: Guards) {
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

function warnPolicySkew(run: HookRun, io: HookIo) {
  if (run.values.report && run.policyDigest && run.paths[0]) {
    const warning = policyDigestWarning(run.paths[0], run.policyDigest);
    if (warning) io.writeError(warning);
  }
}

export async function evaluateHook(
  run: HookRun,
  io: HookIo,
  input: {
    env: Environment;
    event: HostEvent;
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
  const { evidence, digest, watch = false } = connected ?? {};
  const sink = sinkOf(run, io, input.settings, evidence?.token);
  warnPolicySkew(run, io);
  sink?.inventory?.();
  const base = {
    ...hookOptions(run, guards),
    ...reporterOf(run, io, sink),
    keyHost: copilot ? "copilot" : undefined,
  };
  const runs = run.document.version !== 1 || digest !== undefined || watch;
  const access = accessChecks(
    evidence,
    input.settings,
    run.values.agent,
    copilot ? "copilot" : base.host,
  );
  if (step) {
    const recorded = await recordHookStep(step, base, {
      env,
      runs,
      access,
      connected: !!evidence,
    });
    return answer(io, recorded);
  }
  const execution = budgetExecution(watch ? null : sink, {
    env,
    policyDigest: run.policyDigest ?? null,
    fetch: io.fetch,
  });
  const notices: Observed[] = [];
  const observe = copilot
    ? (item: Observed) => notices.push(item)
    : base.observe;
  const prepare = prepareCalls({
    run,
    base: { ...base, observe },
    env,
    connected,
    watch,
    access,
    execution,
    runs,
  });
  const finish = (result: HookResult, patch: boolean) =>
    reportPatch(execution.finish(result, patch), notices, base.observe);
  return answer(
    io,
    await decideForHost(input.event, guards.connections, prepare, finish),
  );
}

async function recordHookStep(
  step: string,
  base: LocalHookOptions,
  context: {
    env: Environment;
    runs: boolean;
    access: ReturnType<typeof accessChecks>;
    connected: boolean;
  },
) {
  if (!context.runs) return allowQuietly;
  const caller = await context.access(step);
  if (caller.accessRefusal || (context.connected && !caller.caller))
    return allowQuietly;
  return runHook(step, { ...base, ...caller }, context.env);
}

function reportPatch(
  result: HookResult,
  notices: Observed[],
  observe: LocalHookOptions["observe"],
) {
  for (const item of notices)
    observe?.(
      result.stdout && told(item.judged) === "allow"
        ? deniedPatch(item, result)
        : item,
    );
  return result;
}

function prepareCalls(input: {
  run: HookRun;
  base: LocalHookOptions;
  env: Environment;
  connected: HookPolicy | null;
  watch: boolean;
  access: ReturnType<typeof accessChecks>;
  execution: ReturnType<typeof budgetExecution>;
  runs: boolean;
}): PrepareTool {
  const { run, base, env, connected, watch, access, execution, runs } = input;
  return async (event) => {
    const caller = await access(event);
    const integrity = watch ? toolIntegrity(event, base) : null;
    const evidence =
      integrity || caller.accessRefusal
        ? null
        : await hookEvidence(event, base, {
            env,
            file: run.values.evidence,
            config: connected ? connected.evidence : undefined,
          });
    const options = {
      ...base,
      ...caller,
      watch: watch && !integrity && !caller.accessRefusal,
      evidence,
    };
    const prepared = caller.accessRefusal
      ? options
      : await execution.prepare(event, options);
    return () => {
      const result = runs
        ? runHook(event, prepared, env)
        : decideToolCall(event, prepared);
      return watch && !caller.accessRefusal
        ? { ...(integrity ?? allowQuietly), stderr: result.stderr }
        : result;
    };
  };
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
