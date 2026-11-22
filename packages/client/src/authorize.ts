// Clearing one governed call: submit it, and when Nodrail allows it, a permit
// checked to be fresh and exactly for this call. Nothing waits for a person:
// any answer but an allow is a deny, with Nodrail's reason.
import {
  actionDigest,
  descriptorDigest,
  isPlainJson,
  type ActionDescriptor,
  type ActionStatus,
} from "./protocol.ts";
import { Blocked } from "./errors.ts";
import type { Decision, NodrailClient, RunRef } from "./client.ts";
import { readSubject, type SubjectReader } from "./subject.ts";

export type AuthorizeOptions = {
  /** The run this call belongs to, so gates and budgets can see its history. */
  run?: RunRef;
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

async function resolve(
  client: NodrailClient,
  descriptor: ActionDescriptor,
  key: string,
  { run, subject }: AuthorizeOptions,
): Promise<Decision> {
  if (!isPlainJson(descriptor.params)) throw new Blocked("INVALID_ACTION");
  const read = () =>
    run && subject !== undefined ? readSubject(subject) : undefined;
  const status = await client.submit(descriptor, key, run, read());
  assertSameCall(status, descriptor);
  // Only READY goes on. Anything else, a hold an older server still answers
  // with included, is a deny with its reason: nothing here waits for it.
  if (status.code !== "READY")
    throw new Blocked(status.code, status.reference, status.reason);

  // Read again: the work may have changed since the call was submitted.
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
