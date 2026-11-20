import type { HookResult } from "./actions.ts";
import type { ConnectionCalls } from "./connections.ts";
import {
  claudeAnswerFor,
  copilotAnswer,
  copilotEvents,
  copilotFromClaude,
  copilotRefusal,
} from "./copilot-hook.ts";
import { readConnections } from "./hook-files.ts";
import { telemetryObserver } from "./hook-telemetry.ts";
import { decideToolCall } from "./local-hook.ts";
import type { PolicyDocument } from "./policies.ts";
import { dataGuard, protectedPaths, setupGuard } from "./rules-guard.ts";
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

export async function hookCommand(run: HookRun, io: HookIo) {
  const guards = readGuards(run.values);
  // Unprotected would be worse than stopped: 2 is what blocks.
  if (typeof guards === "string") {
    io.writeError(guards);
    return 2;
  }
  // Copilot also runs Claude Code's hooks: the call is Copilot's then.
  const copilot =
    run.values.host === "copilot"
      ? "own"
      : (io.env ?? process.env).COPILOT_HOOK_DEPTH !== undefined &&
          hostName(run.values.host) === "claude-code"
        ? "as-claude"
        : null;
  const options = {
    ...hookOptions(run, guards, io),
    ...(copilot ? { canAsk: false } : {}),
  };
  const stdin = await io.readStdin();
  // Rules without gates or budgets never read or write the ledger.
  const decide = (event: string) =>
    run.document.version === 2
      ? runHook(event, options)
      : decideToolCall(event, options);
  const result =
    copilot === "own"
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
