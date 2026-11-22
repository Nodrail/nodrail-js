// A step finishing, as the run ledger records it. Without contracts
// (documents version 1 and 2) the receipt is read by the fixed parser, as
// it always was. With contracts (version 3) an agent with a declared
// receipt is read against it: valid, invalid and missing stay distinct, and
// only a valid receipt gives the step a verdict.
import { nonEmptyText } from "./actions.ts";
import { evidenceOf, hasContracts, type PolicyDocument } from "./policies.ts";
import { parseReceipt } from "./receipts.ts";
import { workRevision } from "./revision.ts";
import type { ReceiptRecord, RunEvent } from "./runs.ts";
import { readContractReceipt, type ReceiptReading } from "./shapes/receipt.ts";

export type Step = { id: string; agent: string };

/** Where a receipt was captured. */
export type Capture = "stop" | "handback";

type Finished = Extract<RunEvent, { type: "step.finished" }>;

/** Whether a gate needs the revision this agent's work was at when it finished. */
const needsSubject = (document: PolicyDocument, agent: string) =>
  hasContracts(document) &&
  document.gates.some((gate) =>
    gate.requires.some(
      (need) => need.agent === agent && need.subject === "revision",
    ),
  );

/** The current revision for a document that asks for one; unknown on any failure. */
export function subjectReader(document: PolicyDocument, cwd: string) {
  const asked =
    hasContracts(document) &&
    document.gates.some(
      (gate) =>
        gate.requires.some((need) => need.subject) ||
        evidenceOf(gate).length > 0,
    );
  if (!asked) return null;
  // Read once per hook call, however many gates and views ask.
  let read: { revision: string | null } | null = null;
  return () => (read ??= { revision: workRevision(cwd) }).revision;
}

function record(
  reading: ReceiptReading,
  name: string,
  contract: string,
  via: Capture,
): ReceiptRecord {
  const valid = reading.state === "valid";
  return {
    name,
    contract,
    state: reading.state,
    via,
    value: valid ? reading.value : null,
    findings: valid ? reading.findings : null,
    issues: valid ? [] : reading.issues,
    reason: valid ? null : reading.reason,
  };
}

/** No message reached the hook: a hand-back that wasn't accepted, or a host that didn't send one. */
const NOTHING: ReceiptReading = {
  state: "missing",
  format: "fenced",
  reason: "the step ended without a final message the hook could read",
  issues: [{ path: "(value)", code: "not-final" }],
};

export type Finishing = {
  document: PolicyDocument;
  step: Step;
  /** The final message; null when the host delivered none. */
  message: string | null;
  via: Capture;
  at: string;
  cwd: string;
};

/** The step.finished event for a step that ended with `message`. */
export function finishedEvent(input: Finishing): Finished {
  const { document, step, message, via, at, cwd } = input;
  const base = {
    type: "step.finished" as const,
    step: step.id,
    agent: step.agent,
    at,
  };
  const subject = needsSubject(document, step.agent)
    ? { subject: workRevision(cwd) }
    : {};
  const contract = hasContracts(document)
    ? document.receipts[step.agent]
    : undefined;
  if (!contract) {
    const receipt = parseReceipt(nonEmptyText(message) ?? "");
    return {
      ...base,
      verdict: receipt?.verdict ?? null,
      findings: receipt?.findings ?? [],
      usage: receipt?.usage ?? {},
      ...subject,
    };
  }
  const reading =
    message === null
      ? NOTHING
      : readContractReceipt(message, contract, step.agent);
  const valid = reading.state === "valid";
  return {
    ...base,
    verdict: valid ? reading.verdict : null,
    findings: [],
    usage: valid ? reading.usage : {},
    receipt: record(reading, contract.name, contract.contract, via),
    ...subject,
  };
}

/** Whether the run already recorded this step's finish: a step completes once. */
export const finishedBefore = (events: RunEvent[], step: Step) =>
  events.some(
    (event) => event.type === "step.finished" && event.step === step.id,
  );
