import { homedir } from "node:os";
import { recordPolicyCheck } from "./hook-policy-status.ts";
import { spoolFolder } from "./telemetry.ts";
import { hookCredential } from "./hook-credential.ts";
import { allowQuietly } from "./actions.ts";
import { readHookConnection, type HookConnection } from "./hook-connection.ts";
import { loadHookPolicy, type HookPolicy } from "./hook-policy.ts";
import {
  answer,
  decideForHost,
  hostEvent,
  hookRefusal,
  isOutcome,
  type HostEvent,
} from "./hook-host-event.ts";
import { evaluateHook, hookOptions } from "./hook-evaluate.ts";
import { hookIsStep } from "./hook-guard.ts";
import { hostName, reporterOf, sinkOf } from "./hook-reporting.ts";
import { toolIntegrity } from "./local-hook.ts";
import type { PolicyDocument } from "./policies.ts";
import type { Environment } from "./run-key.ts";
import { hookGuards, type Guards } from "./hook-setup.ts";
import { runOutcome } from "./run-hook.ts";
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

type RepositoryPolicy = {
  document: PolicyDocument;
  policyDigest: string | null;
};
type LoadRepositoryPolicy = () => Promise<RepositoryPolicy | null>;

const emptyPolicy: PolicyDocument = { version: 1, rules: [] };

async function watchFailure(
  run: Omit<HookRun, "document">,
  io: HookIo,
  failure: {
    event: HostEvent;
    guards: Guards;
    reason: string;
    block?: boolean;
  },
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
  if (failure.block) {
    const refusal = hookRefusal(event, reason);
    return answer(io, { ...refusal, stderr: refusal.stderr || reason });
  }
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

function evaluationFailure(
  input: Omit<HookRun, "document">,
  io: HookIo,
  failure: {
    event: HostEvent;
    guards: Guards;
    settings: HookConnection | null;
    reason: string;
  },
) {
  const { event, settings, reason } = failure;
  const block = settings?.decide === "cloud";
  if (settings?.enforce === "watch")
    return watchFailure(input, io, { ...failure, block });
  if (block) return answer(io, hookRefusal(event, reason));
  io.writeError(reason);
  return event.step ? 0 : 2;
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
  const fail = (reason: string) =>
    evaluationFailure(input, io, {
      event,
      guards,
      settings,
      reason,
    });
  if (error) return fail(error);

  const { connected, policy } = await resolvePolicy(
    input.values.connect,
    { settings, env },
    io,
    local,
  );
  if (typeof connected === "string")
    return answer(io, hookRefusal(event, connected));
  if (!policy)
    return fail(
      connected?.digest
        ? `Nodrail: locked policy ${connected.digest} is unavailable. Restore connectivity or run nodrail apply to regenerate the matching policy.\n`
        : "Nodrail: the hook has no repository policy.\n",
    );
  if (connected?.warning) io.writeError(connected.warning);
  const run: HookRun = {
    ...input,
    ...policy,
    values: event.copilot ? { ...input.values, host: "copilot" } : input.values,
  };
  return evaluateHook(run, io, { env, event, guards, connected, settings });
}

async function resolvePolicy(
  file: string | undefined,
  { settings, env }: { settings: HookConnection | null; env: Environment },
  io: HookIo,
  local: LoadRepositoryPolicy,
) {
  const connected =
    file && settings ? await loadHookPolicy(file, settings, env, io) : null;
  let policy: RepositoryPolicy | null = null;
  try {
    if (typeof connected !== "string")
      policy = await effectivePolicy(
        connected,
        local,
        io,
        settings?.enforce === "watch",
      );
  } finally {
    if (file && settings?.decide === "cloud")
      await recordPolicyCheck(
        spoolFolder(io.home ?? homedir(), file, "policies"),
        settings,
        policy && typeof connected !== "string"
          ? (connected?.state ?? "cached")
          : "unavailable",
        typeof connected === "string"
          ? connected.trim()
          : policy
            ? undefined
            : "No usable policy matches the lock.",
      );
  }
  return { connected, policy };
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
    const policy = await local();
    return connected?.digest && policy?.policyDigest !== connected.digest
      ? null
      : policy;
  } catch (error) {
    if (!watch) throw error;
    io.writeError(`Nodrail: ${(error as Error).message}\n`);
    return null;
  }
}

async function finishOutcome(
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
  const token =
    settings?.decide === "cloud"
      ? await hookCredential(settings, env, io.home).catch(() => undefined)
      : undefined;
  const sink = sinkOf(run, io, settings, token);
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
