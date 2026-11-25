import { decisionSink, type DecisionSink } from "./decision-report.ts";
import type { HookRun, HookIo } from "./hook-command.ts";
import type { HookConnection } from "./hook-connection.ts";
import { telemetryObserver, type Observed } from "./hook-telemetry.ts";
import type { LocalHookOptions } from "./local-hook.ts";

/** The host as the hook reports it: Copilot's calls are judged as Claude Code's. */
export const hostName = (host: string | undefined) =>
  host === "codex" || host === "copilot" ? host : "claude-code";

/** What telemetry and the `--report` sink both start from, for a file. */
const reportingFrom = (run: HookRun, io: HookIo, file: string) => ({
  file,
  host: hostName(run.values.host),
  document: run.document,
  paths: run.paths,
  policyDigest: run.policyDigest,
  home: io.home,
  self: io.self ?? [process.argv[1] ?? ""],
  warn: (text: string) => io.writeError(text),
});

/**
 * The `--report` sink, which records decisions in Nodrail, or null. A
 * verified cloud connection also supplies the sink.
 */
export function sinkOf(
  run: HookRun,
  io: HookIo,
  settings: HookConnection | null,
  token?: string,
) {
  const report =
    settings?.decide === "cloud" ? run.values.connect : run.values.report;
  const sink = report
    ? decisionSink({
        ...reportingFrom(run, io, report),
        env: io.env,
        verified:
          settings?.decide === "cloud"
            ? { config: settings, token }
            : undefined,
      })
    : null;
  return sink;
}

/** Telemetry's observer and run reporter, and the sink's observer, or none. */
export function reporterOf(
  run: HookRun,
  io: HookIo,
  sink: DecisionSink | null,
) {
  const { telemetry } = run.values;
  const reporter = telemetry
    ? telemetryObserver(reportingFrom(run, io, telemetry))
    : null;
  const observers = [reporter?.observe, sink?.observe].filter(
    (observe): observe is NonNullable<typeof observe> => Boolean(observe),
  );
  const report: LocalHookOptions["report"] =
    reporter || sink
      ? (run, event, step) => {
          reporter?.report(run, event);
          sink?.step(run, event, step);
        }
      : null;
  return {
    observe: observers.length
      ? (observed: Observed) => {
          for (const observe of observers) observe(observed);
        }
      : null,
    report,
  };
}
