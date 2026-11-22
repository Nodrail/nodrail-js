import type { HookResult } from "./actions.ts";
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
import { readConnections } from "./hook-files.ts";
import { hookIsStep } from "./hook-guard.ts";
import { telemetryObserver, type Observed } from "./hook-telemetry.ts";
import { decisionSink, type DecisionSink } from "./decision-report.ts";
import { nonEmptyText } from "./actions.ts";
import { decideToolCall, guardRefusalFor, parseEvent } from "./local-hook.ts";
import type { PolicyDocument } from "./policies.ts";
import type { Environment } from "./run-key.ts";
import {
  dataGuard,
  protectedPaths,
  setupGuard,
  withLedger,
} from "./rules-guard.ts";
import { runHook } from "./run-hook.ts";

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
    /** `{ url, credential }`: record each decision and outcome in Nodrail (R388). */
    report?: string;
    host?: string;
    /** `{ url, workspace_revision }` for externally verified evidence; token from NODRAIL_TOKEN. */
    evidence?: string;
  };
  document: PolicyDocument;
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
};

const identityOf = (values: HookRun["values"]) => ({
  agent: values.agent,
  installation: values.installation,
});

/** Copilot's call, judged as the Claude Code calls it is; one answer back. */
function copilotHook(
  stdin: string,
  connections: ConnectionCalls | null,
  decide: (event: string) => HookResult,
) {
  const events = copilotEvents(stdin, Object.keys(connections ?? {}));
  return typeof events === "string"
    ? copilotRefusal(events)
    : copilotAnswer(events.map(decide));
}

type Guards = {
  setup: ReturnType<typeof setupGuard> | null;
  connections: ConnectionCalls | null;
  data: ReturnType<typeof dataGuard> | null;
};

/** The protect list and connections the hook was given; a reason when unreadable. */
function readGuards(values: HookRun["values"]): Guards | string {
  let reading = "the protect list";
  try {
    const setup = values["protect-list"]
      ? setupGuard(values["protect-list"])
      : null;
    reading = "the connections";
    const connections = values.connections
      ? readConnections(values.connections)
      : null;
    const data =
      values.connections && connections
        ? dataGuard(values.connections, connections)
        : null;
    return { setup, connections, data };
  } catch (error) {
    return `Nodrail: can't read ${reading}: ${(error as Error).message}\n`;
  }
}

/** The host as the hook reports it: Copilot's calls are judged as Claude Code's. */
const hostName = (host: string | undefined) =>
  host === "codex" || host === "copilot" ? host : "claude-code";

/** What telemetry and the `--report` sink both start from, for a file. */
const reportingFrom = (run: HookRun, io: HookIo, file: string) => ({
  file,
  host: hostName(run.values.host),
  document: run.document,
  paths: run.paths,
  self: io.self ?? [process.argv[1] ?? ""],
  warn: (text: string) => io.writeError(text),
});

/**
 * The `--report` sink, which records decisions in Nodrail, or null. A
 * call's outcome is queued here, before anything else can fail.
 */
function sinkOf(run: HookRun, io: HookIo, stdin: string) {
  const { report } = run.values;
  const sink = report ? decisionSink(reportingFrom(run, io, report)) : null;
  if (sink && isOutcome(stdin)) sink.outcome(stdin);
  return sink;
}

/** Telemetry's observer and run reporter, and the sink's observer, or none. */
function reporterOf(run: HookRun, io: HookIo, sink: DecisionSink | null) {
  const { telemetry } = run.values;
  const reporter = telemetry
    ? telemetryObserver(reportingFrom(run, io, telemetry))
    : null;
  const observers = [reporter?.observe, sink?.observe].filter(
    (observe): observe is NonNullable<typeof observe> => Boolean(observe),
  );
  return {
    observe: observers.length
      ? (observed: Observed) => {
          for (const observe of observers) observe(observed);
        }
      : null,
    report: reporter?.report ?? null,
  };
}

function hookOptions(
  run: HookRun,
  guards: Guards,
  io: HookIo,
  sink: DecisionSink | null,
) {
  const { values, document, now, paths } = run;
  return {
    document,
    now,
    protect: [...protectedPaths(paths), ...(guards.setup?.paths ?? [])],
    ...guards,
    host:
      values.host === "codex" ? ("codex" as const) : ("claude-code" as const),
    ...reporterOf(run, io, sink),
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

/**
 * The guards with the run ledger protected (R364), as the run hook finds it
 * from the call's folder and from the project's; a reason when it can't be
 * found, for the hook must block then, not run unprotected.
 */
function guardLedger(guards: Guards, stdin: string, env: Environment) {
  if (!guards.setup) return guards;
  const cwd = nonEmptyText(parseEvent(stdin)?.cwd) ?? process.cwd();
  try {
    return {
      ...guards,
      setup: withLedger(guards.setup, [cwd, guards.setup.root], env),
    };
  } catch (error) {
    return `Nodrail: can't find the run ledger to protect: ${(error as Error).message}\n`;
  }
}

/**
 * The local hook's guards alone, for a hook that asks Nodrail for the rest
 * (connected mode, R383): the protect list, the setup, the run ledger and
 * git's folders, and the connections' data, assembled exactly as here, so
 * a connected setup is never weaker than a local one. A refusal, a reason
 * to block when the list or the ledger can't be read, or null.
 */
export function connectedGuard(
  stdin: string,
  input: {
    protectList: string;
    /** The rule files the setup enforces, which no file tool may change. */
    rules: string[];
    connections?: string;
    env: Environment;
    host?: "claude-code" | "codex";
  },
): string | null {
  const read = readGuards({
    "protect-list": input.protectList,
    ...(input.connections ? { connections: input.connections } : {}),
  });
  if (typeof read === "string") return read.trim();
  const guards = guardLedger(read, stdin, input.env);
  if (typeof guards === "string") return guards.trim();
  return guardRefusalFor(stdin, {
    protect: [...protectedPaths(input.rules), ...(guards.setup?.paths ?? [])],
    setup: guards.setup,
    connections: guards.connections,
    data: guards.data,
    host: input.host ?? "claude-code",
  });
}

/**
 * `--unmatched` is `deny` (the default) or `allow`. Any other value blocks
 * the call: a hook can't guess what a setup meant. `ask` was removed, since
 * nothing waits for a person.
 */
function unmatchedProblem(value: string | undefined) {
  if (value === undefined || value === "deny" || value === "allow") return null;
  return value === "ask"
    ? "Nodrail: --unmatched ask was removed: nothing waits for a person. Use --unmatched deny (the default), or allow to leave calls no rule covers to the host's own permissions.\n"
    : `Nodrail: --unmatched is deny or allow, not ${value}.\n`;
}

/** The hook's options and guards as given, or why the hook must stop. */
const startGuards = (values: HookRun["values"]) =>
  unmatchedProblem(values.unmatched) ?? readGuards(values);

export async function hookCommand(run: HookRun, io: HookIo) {
  const read = startGuards(run.values);
  // Unprotected would be worse than stopped: 2 is what blocks.
  if (typeof read === "string") {
    io.writeError(read);
    return 2;
  }
  // The run's files go where the given environment says, never another's.
  const env = io.env ?? process.env;
  const stdin = await io.readStdin();
  const guards = guardLedger(read, stdin, env);
  if (typeof guards === "string") {
    io.writeError(guards);
    return 2;
  }
  const copilot = copilotMode(run.values.host, env);
  const sink = sinkOf(run, io, stdin);
  const base = {
    ...hookOptions(run, guards, io, sink),
    ...(copilot ? { keyHost: "copilot" } : {}),
  };
  // Rules without gates or budgets never read or write the ledger.
  const runs = run.document.version !== 1;
  // Read before the decision, which stays synchronous under the run lock.
  const evidence = await hookEvidence(stdin, base, {
    env,
    file: run.values.evidence,
  });
  const options = { ...base, evidence };
  const decide = (event: string) =>
    runs ? runHook(event, options, env) : decideToolCall(event, options);
  // A subagent starting or stopping is a step, and a call's outcome settles
  // its budgets: recorded, never judged, and a failure from here on must
  // not keep the subagent from stopping or block what already ran.
  const stepEvent = copilotStepEvent(stdin) ?? copilotSettleEvent(stdin);
  if (stepEvent) hookIsStep();
  const step = copilot ? stepEvent : isOutcome(stdin) ? stdin : null;
  const result = step
    ? runs
      ? runHook(step, options, env)
      : { stdout: "", stderr: "", exitCode: 0 }
    : copilot === "own"
      ? copilotHook(stdin, guards.connections, decide)
      : copilot === "as-claude"
        ? claudeAnswerFor(
            copilotHook(copilotFromClaude(stdin), guards.connections, decide),
          )
        : decide(stdin);
  if (result.stdout) io.write(result.stdout);
  if (result.stderr) io.writeError(result.stderr);
  return result.exitCode;
}
