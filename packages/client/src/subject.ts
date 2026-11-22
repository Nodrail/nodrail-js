// What a governed call is about, and what it measured: the work revision a
// gate with `subject: revision` checks evidence against, and the result
// amounts a measured budget adds up. Both are observed by the runtime here,
// never taken from what an agent says.
import { workRevision } from "@nodrail/policy-engine/revision";

/** Reads the revision the work is at; null when it can't be read. */
export type SubjectReader = () => string | null;

const REVISION = /^sha256:[0-9a-f]{64}$/;

/**
 * Reads the subject once, as Cloud receives it: a `sha256:` revision, or
 * null when it is unknown. A reader that throws or returns anything else is
 * unknown too, never a guess, so the gate it feeds stays unmet.
 */
export function readSubject(reader: SubjectReader | null | undefined) {
  if (!reader) return null;
  try {
    const read = reader();
    return typeof read === "string" && REVISION.test(read) ? read : null;
  } catch {
    return null;
  }
}

/** The revision of the git work tree at `cwd`: see workRevision. */
export const revisionAt =
  (cwd: string): SubjectReader =>
  () =>
    workRevision(cwd);

/** One amount a mediated call's result measured, for a budget that sums it. */
export type Measured = { path: string; value: number };

/** At most this many amounts in one report. */
export const MAX_MEASURED = 20;

const RESULT_PATH = /^result(?:\.[a-z][a-z0-9_]{0,62}){1,6}$/;

/**
 * The amounts as Cloud accepts them, or null when any is unusable: a path
 * outside `result.`, a repeated path, or a value that isn't a whole,
 * non-negative, safe number. All or nothing: a budget never adds up part of
 * a reading, and a missing reading is unknown, never zero.
 */
export function checkMeasured(measured: readonly unknown[]): Measured[] | null {
  if (measured.length > MAX_MEASURED) return null;
  const seen = new Set<string>();
  const checked: Measured[] = [];
  for (const item of measured) {
    if (typeof item !== "object" || item === null) return null;
    const { path, value } = item as Record<string, unknown>;
    if (typeof path !== "string" || !RESULT_PATH.test(path)) return null;
    if (seen.has(path)) return null;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
      return null;
    seen.add(path);
    checked.push({ path, value });
  }
  return checked;
}
