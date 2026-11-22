// Local evidence (S05, runtime-observed): what `nodrail evidence run`
// observed, one JSON Lines file per evidence in the ledger folder, so it is
// never committed and every worktree of the repository shares it. The
// envelope is the runtime's; only `value` came from the command, and only
// after validation against the pinned contract. Readers dedupe on `event`.
// Local records can be changed by whoever owns the machine: this is the
// documented trust boundary, not an attestation. Node only.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { withRunLock } from "./ledger.ts";
import { issueList } from "./runs.ts";

const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const time = z.iso.datetime({ offset: true });
export const evidenceName = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/);

export const evidenceEvent = z
  .object({
    type: z.literal("evidence.recorded"),
    /** Made once by the runtime; readers dedupe on it. */
    event: z.uuid(),
    evidence: evidenceName,
    /** The contract the value was validated with, and its projection. */
    contract: digest,
    projection: digest,
    producer: z
      .object({
        class: z.literal("runtime-observed"),
        id: z.string().min(1).max(100),
      })
      .strict(),
    /** The revision the work was at before and after; null when it changed or can't be read. */
    subject: z
      .object({ kind: z.literal("revision"), digest })
      .strict()
      .nullable(),
    observed: z
      .object({
        exit_code: z.number().int(),
        started_at: time,
        finished_at: time,
      })
      .strict(),
    validation: z
      .object({
        state: z.enum(["valid", "invalid", "missing"]),
        issues: issueList,
      })
      .strict(),
    /** The full value, local only; null unless valid. */
    value: z.record(z.string(), z.unknown()).nullable(),
  })
  .strict()
  .refine((e) => e.validation.state === "valid" || e.value === null, {
    path: ["value"],
    message: "Only a valid value is kept",
  });
export type EvidenceEvent = z.infer<typeof evidenceEvent>;

/** The folder evidence files live in, inside the ledger folder. */
export const evidenceDirectory = (ledger: string) => join(ledger, "evidence");

export const evidenceFile = (ledger: string, name: string) =>
  join(evidenceDirectory(ledger), `${evidenceName.parse(name)}.jsonl`);

/**
 * Every readable event of one evidence, in the order recorded, once each.
 * A line that can't be read is skipped: it can never satisfy a gate, and
 * one bad line shouldn't hide the events after it.
 */
export function readEvidence(ledger: string, name: string): EvidenceEvent[] {
  const file = evidenceFile(ledger, name);
  if (!existsSync(file)) return [];
  const seen = new Set<string>();
  const events: EvidenceEvent[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let parsed: EvidenceEvent;
    try {
      parsed = evidenceEvent.parse(JSON.parse(line));
    } catch {
      continue;
    }
    if (parsed.evidence !== name || seen.has(parsed.event)) continue;
    seen.add(parsed.event);
    events.push(parsed);
  }
  return events;
}

/** Adds one event as one whole line, under the evidence's own lock. */
export function recordEvidence(ledger: string, event: EvidenceEvent) {
  const checked = evidenceEvent.parse(event);
  const folder = evidenceDirectory(ledger);
  mkdirSync(folder, { recursive: true });
  withRunLock(folder, `evidence:${checked.evidence}`, () => {
    const file = evidenceFile(ledger, checked.evidence);
    // A write cut off mid-line stays its own (unreadable, skipped) line.
    const torn =
      existsSync(file) && !readFileSync(file, "utf8").endsWith("\n")
        ? readFileSync(file, "utf8").length > 0
        : false;
    appendFileSync(file, `${torn ? "\n" : ""}${JSON.stringify(checked)}\n`);
  });
}
