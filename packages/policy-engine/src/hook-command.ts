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
import { telemetryObserver } from "./hook-telemetry.ts";
import { nonEmptyText } from "./actions.ts";
import { decideToolCall, parseEvent } from "./local-hook.ts";
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

/** Telemetry's observer and run reporter, or neither. */
function reporterOf(run: HookRun, io: HookIo) {
  const reporter = run.values.telemetry
    ? telemetryObserver({
        file: run.values.telemetry,
        host: hostName(run.values.host),
        document: run.document,
        paths: run.paths,
        self: io.self ?? [process.argv[1] ?? ""],
        warn: (text) => io.writeError(text),
      })
    : null;
  return {
    observe: reporter?.observe ?? null,
    report: reporter?.report ?? null,
  };
}

function hookOptions(run: HookRun, guards: Guards, io: HookIo) {
  const { values, document, now, paths } = run;
  return {
    document,
    now,
    protect: [...protectedPaths(paths), ...(guards.setup?.paths ?? [])],
    ...guards,
    // Codex and Copilot can't ask the person from a hook.
    canAsk: hostName(values.host) === "claude-code",
    host:
      values.host === "codex" ? ("codex" as const) : ("claude-code" as const),
    ...reporterOf(run, io),
    unmatched:
      values.unmatched === "ask" ? ("ask" as const) : ("deny" as const),
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

export async function hookCommand(run: HookRun, io: HookIo) {
  const read = readGuards(run.values);
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
  const base = {
    ...hookOptions(run, guards, io),
    ...(copilot ? { canAsk: false, keyHost: "copilot" } : {}),
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
