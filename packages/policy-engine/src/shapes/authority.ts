// Authority and privacy around a contract (DC-00.2): who produced a record,
// the runtime-owned envelope no agent field can fill, the reported record
// that crosses to Cloud.
import { z } from "zod";
import { PRODUCER_CLASSES, shapeName, type ProducerClass } from "./grammar.ts";
import { SURFACES } from "./types.ts";

export { PRODUCER_CLASSES, type ProducerClass } from "./grammar.ts";

/**
 * How far a gate may trust each class. A person who signed in to Cloud is a
 * separate line: it answers forms and owns labels, and never stands in for
 * a verifier or a runtime observation, nor they for it.
 */
const RANK: Record<ProducerClass, number | null> = {
  "agent-reported": 0,
  "runtime-observed": 1,
  "externally-verified": 2,
  "person-authenticated": null,
};

/** Whether a record from `have` meets a requirement for `need`. */
export function satisfiesAuthority(have: ProducerClass, need: ProducerClass) {
  if (need === "person-authenticated" || have === "person-authenticated")
    return have === need;
  return RANK[have]! >= RANK[need]!;
}

/**
 * Metadata the runtime or server sets, outside the contract's properties.
 * A receipt's `agent` is the one envelope field an agent writes, and it only
 * has to match the dispatch the runtime observed.
 */
export const RUNTIME_FIELDS = [
  "surface",
  "producer",
  "contract",
  "projection",
  "validation",
  "project",
  "machine",
  "host",
  "run",
  "step",
  "agent",
  "dispatch",
  "event",
  "occurred_at",
  "recorded_at",
  "subject",
] as const;

const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const id = z.string().min(1).max(200);
const time = z.iso.datetime({ offset: true });

/** Validation states stay distinct: invalid is not missing, missing is not unsupported. */
export const VALIDATION_STATES = [
  "valid",
  "invalid",
  "missing",
  "unsupported",
] as const;

export const recordEnvelope = z.strictObject({
  surface: z.enum(SURFACES),
  producer: z.strictObject({ class: z.enum(PRODUCER_CLASSES), id }),
  contract: z.strictObject({ name: shapeName, digest, dialect: z.literal(1) }),
  /** Null on a full record that never leaves its authority. */
  projection: z.strictObject({ digest }).nullable(),
  validation: z.strictObject({
    state: z.enum(VALIDATION_STATES),
    /** Where full validation ran. Cloud can't attest to what it never saw. */
    at: z.enum(["local", "server"]),
    issues: z
      .array(
        z.strictObject({ path: z.string().max(400), code: z.string().max(40) }),
      )
      .max(20),
  }),
  /** The stable project id, or unbound:<name>. */
  project: id,
  machine: id.nullable(),
  host: z.strictObject({ runtime: id, version: id }).nullable(),
  run: id.nullable(),
  step: id.nullable(),
  /** Who the runtime observed was dispatched; never taken from the payload. */
  agent: id.nullable(),
  dispatch: id.nullable(),
  /** Stable across retries, so the server deduplicates. */
  event: id,
  occurred_at: time,
  recorded_at: time,
  /** What the record is about, bound by the runtime: never a self-declared "fresh". */
  subject: z.strictObject({
    kind: z.enum(["revision", "action", "file", "none"]),
    digest: id.nullable(),
  }),
});
export type RecordEnvelope = z.infer<typeof recordEnvelope>;

/**
 * What a reporting client sends: the envelope and the projected values. The
 * server validates `values` against the projection the digest names and
 * keeps `validation` as the producer's claim about the full value.
 */
export const reportedRecord = z.strictObject({
  envelope: recordEnvelope.refine((envelope) => envelope.projection !== null, {
    message: "A reported record names its projection",
  }),
  values: z.record(z.string(), z.unknown()),
  /** Derived by the runtime from a valid value's findings role. */
  findings_count: z.number().int().min(0).nullable(),
});
export type ReportedRecord = z.infer<typeof reportedRecord>;
