import { createHash, randomBytes } from "node:crypto";
import {
  readHostCredential,
  writeHostCredential,
} from "@nodrail/policy-engine/command-line";
import { CliError } from "../io.ts";
import type { Place } from "../project/store.ts";
import {
  appliedEnrollments,
  generationOf,
  rememberEnrollment,
  rememberIntent,
  sameDestination,
  withEnrollmentLock,
  type AppliedEnrollment,
  type EnrollmentIntent,
} from "./applied-enrollment.ts";
import type { Publication } from "./connect-policy.ts";
import { saveMachineId } from "./machine.ts";

function enrollmentIntent(
  place: Place,
  binding: Publication["binding"],
  machineId: string,
  knownCredential: string | undefined,
) {
  const pending = appliedEnrollments(place).find(
    (entry): entry is EnrollmentIntent =>
      "credential" in entry && sameDestination(entry, binding),
  );
  if (pending) return pending;
  if (knownCredential) return { ...binding, credential: knownCredential };
  const credential = `ndr_${randomBytes(6).toString("hex")}_${randomBytes(32).toString("base64url")}`;
  const intent = { ...binding, machineId, credential };
  rememberIntent(place, intent);
  return intent;
}

/** Persist the revocation secret before the server can activate its digest. */
export async function publishPolicy(
  { api, body, binding }: Publication,
  place: Place,
  known?: AppliedEnrollment,
) {
  const machine = body.machine;
  if (!machine) return { ...(await api.applyProject(body)), enrolled: false };
  return withEnrollmentLock(place, binding, async (lock) => {
    await saveMachineId(place.home, machine.id);
    const previous = await readHostCredential(place.home, binding);
    const intent = lock.commit(() =>
      enrollmentIntent(
        place,
        binding,
        machine.id,
        known ? machine.credential : undefined,
      ),
    );
    const prefix = generationOf(intent.credential);
    const digest = createHash("sha256")
      .update(intent.credential.slice(17))
      .digest("hex");
    const credential =
      machine.expected_credential === prefix
        ? intent.credential
        : machine.credential;
    lock.renew();
    const result = await api.applyProject({
      ...body,
      machine: {
        ...machine,
        credential,
        proposed_credential: { prefix, digest },
      },
    });
    lock.renew();
    const enrollment = result.enrollment;
    if (!enrollment)
      throw new CliError(
        "Apply did not confirm machine enrollment. Run nodrail apply again.",
      );
    const secret =
      enrollment.credential ??
      (enrollment.credential_generation === prefix
        ? intent.credential
        : credential);
    if (
      !secret ||
      (enrollment.credential_generation &&
        enrollment.credential_generation !== generationOf(secret))
    )
      throw new CliError(
        "Apply did not confirm the machine credential generation. Run nodrail apply again.",
      );
    const saved = {
      ...binding,
      installationId: enrollment.installation_id,
      machineId: machine.id,
      credential: secret,
    };
    // A confirmed rotation retires the old key. Preserve the new secret
    // as the sole recovery record until both local files have been saved.
    lock.commit(() => rememberIntent(place, saved, true));
    await writeHostCredential(place.home, saved, {
      commit: lock.commit,
      previousGeneration: previous
        ? generationOf(previous.credential)
        : undefined,
    });
    lock.commit(() =>
      rememberEnrollment(place, { ...saved, generation: generationOf(secret) }),
    );
    return {
      ...result,
      enrolled:
        !!enrollment.credential ||
        (secret === intent.credential && !credential),
    };
  });
}

export function rememberCurrentEnrollment(
  place: Place,
  binding: AppliedEnrollment,
) {
  return withEnrollmentLock(place, binding, async (lock) => {
    const current = await readHostCredential(place.home, binding);
    if (
      current?.installationId !== binding.installationId ||
      generationOf(current.credential) !== binding.generation
    )
      throw new CliError(
        "The machine credential changed. Run nodrail apply again.",
      );
    lock.commit(() => rememberEnrollment(place, binding));
  });
}
