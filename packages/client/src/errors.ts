// How a call to Cloud fails, and which failures a retry or an older
// server explains.

/** Why a call is blocked, with where the server answered from. */
export class Blocked extends Error {
  constructor(
    readonly code: string,
    readonly reference: string | null = null,
    readonly reason: string | null = null,
    /** The HTTP status, when the server answered at all. */
    readonly status: number | null = null,
  ) {
    super(code);
  }
}

/** Worth sending again with the same key: nothing was decided. */
export const transient = (error: unknown) =>
  error instanceof Blocked &&
  (error.code === "UNAVAILABLE" ||
    error.code === "RATE_LIMITED" ||
    (error.status !== null && error.status >= 500));

/** The same key was already taken: the report is in. */
export const alreadyIn = (error: unknown) =>
  error instanceof Blocked &&
  (error.status === 409 || error.code === "IDEMPOTENCY_CONFLICT");

/**
 * A server from before Wave 3 refuses fields it doesn't know (`run.subject`,
 * the permit's `subject`, a report's `measured`). Sent again without them,
 * it decides as it always did: without a subject a gate on the revision
 * stays unmet there, and without a reading a measured budget has none.
 * Nothing is ever assumed in their place.
 */
export const refusedNewFields = (error: unknown) =>
  error instanceof Blocked && error.code === "INVALID_INPUT";

/** Pauses between report attempts; their count bounds the retries. */
export const REPORT_RETRY_MS = [200, 800] as const;

export const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
