// Evidence for the hook's decision (version 4): local runtime-observed
// events from the ledger folder, and Cloud's answers for externally
// verified ones. Cloud is asked only about requirements of gates that cover
// this call and aren't met here, all at once, before the decision; the
// decision itself stays synchronous under the run lock.
import { nonEmptyText } from "./actions.ts";
import { readEvidence, type EvidenceEvent } from "./evidence.ts";
import {
  readRemoteConfig,
  remoteStatuses,
  type RemoteConfig,
} from "./evidence-remote.ts";
import { ledgerDirectory, type Environment } from "./ledger.ts";
import {
  judgeToolCall,
  parseEvent,
  type LocalHookOptions,
} from "./local-hook.ts";
import { evidenceOf, type PolicyDocument } from "./policies.ts";
import { workRevision } from "./revision.ts";
import type { EvidenceReader, RemoteStatus } from "./run-evidence.ts";

const hasEvidence = (document: PolicyDocument) =>
  document.version === 4 &&
  document.gates.some((gate) => evidenceOf(gate).length > 0);

/** Local events, read at most once per evidence. */
function localReader(ledger: string | null) {
  const read = new Map<string, EvidenceEvent[]>();
  return (name: string) => {
    if (!ledger) return [];
    let events = read.get(name);
    if (!events) {
      try {
        events = readEvidence(ledger, name);
      } catch {
        events = [];
      }
      read.set(name, events);
    }
    return events;
  };
}

/** The `--evidence` file and NODRAIL_TOKEN, or null: then only local evidence counts. */
function configOf(file: string | undefined, env: Environment) {
  if (!file) return null;
  try {
    return readRemoteConfig(file, env);
  } catch {
    return null;
  }
}

/**
 * The evidence reader for one hook call, or null when the rules have no
 * evidence requirement. Never throws: what can't be read is unmet.
 */
export async function hookEvidence(
  stdin: string,
  options: LocalHookOptions,
  input: { env: Environment; file?: string; config?: RemoteConfig | null },
): Promise<EvidenceReader | null> {
  if (!hasEvidence(options.document)) return null;
  const event = parseEvent(stdin);
  const cwd = nonEmptyText(event?.cwd) ?? process.cwd();
  let ledger: string | null = null;
  try {
    ledger = ledgerDirectory(cwd, input.env);
  } catch {
    ledger = null;
  }
  const local = localReader(ledger);
  const found = new Map<string, RemoteStatus>();
  const reader: EvidenceReader = {
    local,
    remote: (gate, index) => found.get(`${gate}#${index}`) ?? null,
  };
  const config =
    input.config === undefined ? configOf(input.file, input.env) : input.config;
  if (!config || !ledger || event?.hook_event_name !== "PreToolUse")
    return reader;
  const subject = workRevision(cwd);
  if (!subject) return reader;
  // Which gates cover this call, and which of their evidence isn't met here.
  const { decision } = judgeToolCall(stdin, {
    ...options,
    run: null,
    observe: null,
    report: null,
    evidence: reader,
    subject: () => subject,
  });
  const unmet = (decision?.gates ?? []).flatMap((gate) =>
    gate.applies
      ? (gate.evidence ?? []).map(({ index }) => ({ gate: gate.id, index }))
      : [],
  );
  if (!unmet.length) return reader;
  const answers = await remoteStatuses(
    config,
    unmet.map((ask) => ({ ...ask, subject })),
    { ledger, now: options.now },
  );
  for (const [key, status] of answers) found.set(key, status);
  return reader;
}
