// `@nodrail/policy-engine/ledger`: the local run ledger as the hooks use it,
// for the CLI and mediated connectors. Write only under `withRunLock`, so a
// hook deciding the next call in the same run sees what was written; and
// numeric budgets (reserve, settle, reconcile) and local evidence. Node only.
import {
  mediatedSettlement,
  type MediatedSettlement,
} from "./budget-ledger.ts";
import { readRun, record } from "./ledger.ts";

export {
  MAX_EVENTS,
  ledgerDirectory,
  readRun,
  readRuns,
  record,
  runFile,
  runKey,
  withRunLock,
  type Environment,
} from "./ledger.ts";
export {
  covers,
  earlierDelivery,
  explainLimit,
  holds,
  limitState,
  mediatedSettlement,
  openKeys,
  reconcile,
  reservationsFor,
  settle,
  settlements,
  type BudgetAuthority,
  type BudgetCall,
  type LimitState,
  type MediatedSettlement,
  type Settlement,
} from "./budget-ledger.ts";
export {
  dayWindow,
  isTimeZone,
  localDate,
  type DayWindow,
} from "./budget-windows.ts";
export {
  evidenceDirectory,
  evidenceEvent,
  evidenceFile,
  readEvidence,
  recordEvidence,
  type EvidenceEvent,
} from "./evidence.ts";
export {
  fetchEvidenceStatus,
  readRemoteConfig,
  remoteStatuses,
  POSITIVE_CACHE_MS,
  REMOTE_TIMEOUT_MS,
  type RemoteAsk,
  type RemoteConfig,
} from "./evidence-remote.ts";
export {
  describeEvidence,
  evidenceShortfall,
  type EvidenceReader,
  type RemoteStatus,
} from "./run-evidence.ts";

/**
 * Settles a mediated call's budget reservation and records what it measured
 * (the connector's `BudgetSettler`): succeeded is consumed, failed and
 * not-called are released, unknown stays counted. Call it holding the
 * run's lock, right after the call is recorded. Returns what it wrote.
 */
export function settleMediatedCall(
  directory: string,
  run: string,
  call: MediatedSettlement,
  now: Date = new Date(),
) {
  const written = mediatedSettlement(
    readRun(directory, run),
    call,
    now.toISOString(),
  );
  for (const event of written) record(directory, run, event);
  return written;
}
