// A mediated connection's calls in the run ledger:
// each call becomes a `connection.call` event wrapping the connector's
// record, appended under the run's lock, so a hook deciding the next call
// in the same run reads it. A budget's settlement, when one is plugged in,
// happens under the same lock right after it. The ledger is the engine's:
// its folder and run key, its writer and its lock; nothing here re-implements
// them. A failure throws, and `mediateTools` reports it without holding back
// the agent's answer; the records file keeps the call either way.
import { MAIN_AGENT, type RunEvent } from "@nodrail/policy-engine";
import { ledgerDirectory, runKey } from "@nodrail/policy-engine/hook-runs";
import type { MediatedCall, RecordSink } from "./mediate.ts";
import { settledCall, type BudgetSettler } from "./measure.ts";

/**
 * The engine's run ledger, as its hooks use it: `record` adds one checked
 * event as one line, and must run inside `withRunLock`.
 */
export type RunLedger = {
  record(directory: string, run: string, event: RunEvent): void;
  withRunLock<T>(directory: string, run: string, work: () => T): T;
};

/** The ledger folder and the run a connector's calls go to. */
export type LedgerPlace = { directory: string; run: string };

type Environment = Record<string, string | undefined>;

/**
 * Where a connector started in `cwd` records its calls: the ledger the hooks
 * of that folder use, and the run NODRAIL_RUN names, else the branch's run.
 * A connector isn't told the host's session, so on the default branch with
 * no NODRAIL_RUN there is no run to join: null, and only the records file
 * keeps the call.
 */
export function ledgerPlace(
  cwd: string,
  env: Environment = process.env,
): LedgerPlace | null {
  const run = runKey(cwd, null, env);
  return run ? { directory: ledgerDirectory(cwd, env), run } : null;
}

/**
 * A call as a run event: at the call's time, by the main agent outside any
 * step, since a connector doesn't know which step of the run called it.
 */
export const connectionCallEvent = (call: MediatedCall): RunEvent => ({
  type: "connection.call",
  step: null,
  agent: MAIN_AGENT,
  at: call.occurred_at,
  call,
});

export type LedgerSinkOptions = {
  ledger: RunLedger;
  place: LedgerPlace | null;
  /** Settles the call's budget reservation; none until the engine has one. */
  settle?: BudgetSettler;
};

/** A record sink that appends each call to the run ledger, under its lock. */
export function ledgerSink(options: LedgerSinkOptions): RecordSink {
  const { ledger, place, settle } = options;
  return (call, details) => {
    if (!place) return;
    const event = connectionCallEvent(call);
    ledger.withRunLock(place.directory, place.run, () => {
      ledger.record(place.directory, place.run, event);
      settle?.(settledCall(call, details));
    });
  };
}
