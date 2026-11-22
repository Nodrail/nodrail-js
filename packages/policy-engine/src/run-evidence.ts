// What evidence proves to a gate requirement (S05 on C01), and why it
// falls short, in a fixed order: the first failure is the explanation.
//   1. the current revision can't be read
//   2. no event for this revision
//   3. the producer class is below the authority asked
//   4. the verifier was revoked (Cloud answers this one)
//   5. validated against another revision of the contract
//   6. the value is invalid or missing
//   7. `where` fails (the declared condition only, never an observed value)
// Local runtime-observed events are read from the ledger; externally
// verified ones come from Cloud's answer for the published requirement,
// never from a condition this side sends.
import type { EvidenceEvent } from "./evidence.ts";
import type { EvidenceNeed } from "./policies.ts";
import { satisfiesAuthority } from "./shapes/authority.ts";
import { matchWhere } from "./shapes/validate.ts";

/**
 * Cloud's answer for one published requirement and subject: the
 * `GET /api/v1/evidence/status` body as Cloud sends it (`EvidenceStatusDto`).
 * `reason_code` is Cloud's (`met`, `no_event`, `verifier_revoked`…), or
 * one this side sets when there was no answer: `offline`, `unauthorized`,
 * `unpublished` or `error`.
 */
export type RemoteStatus = {
  met: boolean;
  reason_code: string;
  /** The event that decided, if one did. */
  event_id: string | null;
  verifier: { name: string; revoked_at: string | null } | null;
  received_at: string | null;
};

/** Reads evidence for one decision; each source is read at most once. */
export type EvidenceReader = {
  /** Local events of one evidence, in the order recorded. */
  local(name: string): EvidenceEvent[];
  /** Cloud's answer for a gate's requirement, or null when not asked. */
  remote(gate: string, index: number): RemoteStatus | null;
};

const short = (digest: string) => digest.replace(/^sha256:/, "").slice(0, 12);

/** The words for a code Cloud gave (its `evidenceReasons`); never a value. */
const REASONS: Record<
  string,
  (need: EvidenceNeed, status: RemoteStatus) => string
> = {
  subject_unknown: () => "the current revision can't be read",
  no_event: (need) => `no ${need.evidence} for this revision`,
  authority: (need) => `${need.evidence} here is below ${need.authority}`,
  producer_not_allowed: (need) =>
    `the latest ${need.evidence} for this revision comes from a verifier this requirement doesn't accept`,
  verifier_revoked: (_need, { verifier }) =>
    `the verifier${verifier ? ` ${verifier.name}` : ""} was revoked${verifier?.revoked_at ? ` on ${verifier.revoked_at.slice(0, 10)}` : ""}; its evidence no longer counts`,
  contract_mismatch: (need) =>
    `the latest ${need.evidence} was validated against another revision of its contract; run the producer again under the published contract`,
  invalid: (need) => `the latest ${need.evidence} for this revision is invalid`,
  where_unmet: (need) =>
    `the latest ${need.evidence} for this revision doesn't meet the where conditions`,
  unpublished: () =>
    "this workspace revision isn't published, so Cloud can't answer for it",
  unauthorized: () => "the token can't read evidence (it needs the read scope)",
  offline: () => "Cloud couldn't be reached",
};

function remoteReason(need: EvidenceNeed, status: RemoteStatus | null) {
  if (!status)
    return `${need.evidence} is ${need.authority}, which only Cloud can confirm, and this hook has no Cloud connection to ask`;
  const code = status.reason_code;
  const words = Object.hasOwn(REASONS, code) ? REASONS[code] : undefined;
  return words?.(need, status) ?? `Cloud couldn't confirm ${need.evidence}`;
}

/** The latest local event of the evidence, and the latest about this revision. */
function latest(events: EvidenceEvent[], subject: string) {
  let any: EvidenceEvent | null = null;
  let here: EvidenceEvent | null = null;
  for (const event of events) {
    any = event;
    if (event.subject?.digest === subject) here = event;
  }
  return { any, here };
}

function localShortfall(
  need: EvidenceNeed,
  events: EvidenceEvent[],
  subject: string,
  clean: string | null,
): string | null {
  const { any, here } = latest(events, subject);
  if (!here) {
    if (any?.subject && clean && any.subject.digest === clean)
      return `your tree has uncommitted or untracked changes; ${need.evidence} was recorded for the commit only`;
    return any?.subject
      ? `no ${need.evidence} for this revision (the latest is for ${short(any.subject.digest)}…; the work changed since)`
      : `no ${need.evidence} for this revision`;
  }
  if (!satisfiesAuthority(here.producer.class, need.authority))
    return `${need.evidence} here is ${here.producer.class}; this gate needs ${need.authority}`;
  if (here.contract !== need.contract)
    return `the latest ${need.evidence} was validated against another revision of its contract; run the producer again under the published contract`;
  if (here.validation.state === "missing")
    return `the latest ${need.evidence} for this revision has no result: its command wrote none`;
  if (here.validation.state === "invalid") {
    const issues = here.validation.issues.map((i) => `${i.path}: ${i.code}`);
    return `the latest ${need.evidence} for this revision is invalid (${issues.join(", ") || "invalid"})`;
  }
  if (need.where.length && !matchWhere(need.where, here.value))
    return `the latest ${need.evidence} for this revision doesn't meet the where conditions`;
  return null;
}

/**
 * Why an evidence requirement is unmet, or null when it is met. `subject`
 * is the current revision; `clean` the revision of a clean checkout of
 * HEAD, which tells an uncommitted change from a new commit.
 */
export function evidenceShortfall(
  need: EvidenceNeed,
  where: { gate: string; index: number },
  reading: {
    subject: string | null;
    clean?: string | null;
    evidence: EvidenceReader | null;
  },
): string | null {
  const { subject, evidence } = reading;
  if (!subject) return "the current revision can't be read";
  if (!evidence) return `${need.evidence} can't be read here`;
  // A runtime-observed (or weaker) requirement can be met on this machine.
  const local =
    need.authority === "externally-verified"
      ? null
      : localShortfall(
          need,
          evidence.local(need.evidence),
          subject,
          reading.clean ?? null,
        );
  if (need.authority !== "externally-verified" && local === null) return null;
  const remote = evidence.remote(where.gate, where.index);
  if (remote?.met) return null;
  // Cloud's reason when only Cloud can meet it, else what was seen here.
  if (need.authority === "externally-verified" || (remote && !local))
    return remoteReason(need, remote);
  return local;
}

/** The requirement in words: only declared values. */
export function describeEvidence(need: EvidenceNeed) {
  return `${need.evidence} (${need.authority}) on the current revision${need.where.length ? " meeting its where conditions" : ""}`;
}
