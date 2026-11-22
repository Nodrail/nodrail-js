// Clearing one governed call: submit, wait for a person if needed, then a
// permit checked to be fresh and exactly for this call.
import {
  actionDigest,
  descriptorDigest,
  isPlainJson,
  type ActionDescriptor,
  type ActionStatus,
} from "./protocol.ts";
import { Blocked, defaultSleep } from "./errors.ts";
import type { Decision, NodrailClient, RunRef } from "./client.ts";
import { readSubject, type SubjectReader } from "./subject.ts";

export type AuthorizeOptions = {
  /** How long to wait for a person before giving up and blocking. */
  waitMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** The run this call belongs to, so gates and budgets can see its history. */
  run?: RunRef;
  /** Stops waiting for a person early, as if `waitMs` had passed. */
  signal?: AbortSignal;
  /**
   * Reads the work revision, sent with the run at submit and read again at
   * permit. Only read when there is a run; unreadable is sent as null
   * (unknown), never left out or guessed. Without a reader nothing is sent.
   */
  subject?: SubjectReader | null;
};

/** Checks the server described the very call that is about to be made. */
function assertSameCall(status: ActionStatus, descriptor: ActionDescriptor) {
  const digest = descriptorDigest(status.installation_id, descriptor);
  if (
    status.descriptor_digest !== digest ||
    status.action_digest !== actionDigest(status.action_id, digest)
  )
    throw new Blocked("DIGEST_MISMATCH", status.reference);
}

const waiting = new Set(["APPROVAL_PENDING", "UNKNOWN_PERMISSION_BLOCKED"]);

/** How long giving up may take: the block never waits on Cloud for longer. */
export const WITHDRAW_TIMEOUT_MS = 3000;

/** Best effort: whatever happens, the caller gets the same block. */
async function withdrawQuietly(client: NodrailClient, actionId: string) {
  try {
    await client.withdraw(actionId, { timeoutMs: WITHDRAW_TIMEOUT_MS });
  } catch {
    // A request left open expires on its own; it can never become an allow.
  }
}

/** A pause between checks that ends at once when the caller stops waiting. */
async function pause(
  ms: number,
  sleep: AuthorizeOptions["sleep"],
  signal?: AbortSignal,
) {
  const slept = (sleep ?? defaultSleep)(ms);
  if (!signal) return slept;
  let stop = () => {};
  const stopped = new Promise<void>((done) => {
    stop = done;
    if (signal.aborted) done();
    else signal.addEventListener("abort", stop, { once: true });
  });
  try {
    await Promise.race([slept, stopped]);
  } finally {
    signal.removeEventListener("abort", stop);
  }
}

/**
 * Polls until a person decides. Giving up after waiting takes the request
 * back; with `waitMs: 0` it stays open, for a caller that comes back later.
 */
async function waitForPerson(
  client: NodrailClient,
  descriptor: ActionDescriptor,
  submitted: ActionStatus,
  { waitMs = 0, pollMs = 2000, sleep, signal }: AuthorizeOptions,
): Promise<ActionStatus> {
  let status = submitted;
  const deadline = Date.now() + waitMs;
  while (waiting.has(status.code)) {
    if (Date.now() >= deadline || signal?.aborted) {
      if (waitMs > 0) await withdrawQuietly(client, status.action_id);
      throw new Blocked(status.code, status.reference, status.reason);
    }
    await pause(pollMs, sleep, signal);
    if (signal?.aborted) continue;
    status = await client.status(status.action_id);
    assertSameCall(status, descriptor);
  }
  return status;
}

async function resolve(
  client: NodrailClient,
  descriptor: ActionDescriptor,
  key: string,
  options: AuthorizeOptions,
): Promise<Decision> {
  if (!isPlainJson(descriptor.params)) throw new Blocked("INVALID_ACTION");
  const { run, subject } = options;
  const read = () =>
    run && subject !== undefined ? readSubject(subject) : undefined;
  const submitted = await client.submit(descriptor, key, run, read());
  assertSameCall(submitted, descriptor);

  const status = await waitForPerson(client, descriptor, submitted, options);
  if (status.code !== "READY")
    throw new Blocked(status.code, status.reference, status.reason);

  // Read again: the work may have changed while a person decided.
  const permit = await client.permit(status, read());
  return {
    allowed: true,
    actionId: permit.action_id,
    permitId: permit.permit_id,
  };
}

/**
 * The only way a governed call should be cleared. It runs only on
 * `allowed: true`; a timeout, an error, or anything unexpected is a block.
 */
export async function authorize(
  client: NodrailClient,
  descriptor: ActionDescriptor,
  key: string,
  options: AuthorizeOptions = {},
): Promise<Decision> {
  try {
    return await resolve(client, descriptor, key, options);
  } catch (error) {
    return error instanceof Blocked
      ? {
          allowed: false,
          code: error.code,
          reason: error.reason,
          reference: error.reference,
        }
      : { allowed: false, code: "CLIENT_ERROR", reason: null, reference: null };
  }
}
