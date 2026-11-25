import { createHash } from "node:crypto";
import {
  readSecretFile,
  removeSecretFile,
  writeSecretFile,
} from "@nodrail/policy-engine/command-line";
import { basename, join } from "node:path";
import { z } from "zod";
import {
  holdProject,
  holdProjectAsync,
  stagingFolder,
  type Place,
  type WriterLock,
} from "../project/store.ts";

const destinationShape = z.object({
  origin: z.url(),
  workspace: z.string(),
  environment: z.string(),
  projectId: z.uuid(),
});
const bindingShape = destinationShape.extend({
  installationId: z.uuid(),
  generation: z
    .string()
    .regex(/^[a-f0-9]{12}$/)
    .optional(),
});
const intentShape = destinationShape.extend({
  machineId: z.uuid().optional(),
  credential: z.string().regex(/^ndr_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/),
});
const record = z.array(z.union([bindingShape, intentShape]));
export type AppliedEnrollment = z.infer<typeof bindingShape>;
export type EnrollmentIntent = z.infer<typeof intentShape>;
export type EnrollmentRecord = AppliedEnrollment | EnrollmentIntent;
export type EnrollmentDestination = z.infer<typeof destinationShape>;

export const generationOf = (credential: string) => credential.slice(4, 16);

/** The credential store is shared even across checkouts of the same project. */
export function withEnrollmentLock<T>(
  { home }: Place,
  binding: EnrollmentDestination,
  work: (lock: WriterLock) => Promise<T>,
) {
  const { origin, workspace, environment, projectId } = binding;
  const key = createHash("sha256")
    .update(JSON.stringify([origin, workspace, environment, projectId]))
    .digest("hex");
  const folder = join(home, ".nodrail", "writes", `enrollment-${key}`);
  return holdProjectAsync(folder, work);
}

const folder = (place: Place) => join(place.home, ".nodrail", "applied");
const path = (place: Place) =>
  join(folder(place), `${basename(stagingFolder(place))}.json`);

export function appliedEnrollments(place: Place): EnrollmentRecord[] {
  const text = readSecretFile(path(place));
  return text === null ? [] : record.parse(JSON.parse(text));
}

function update(
  place: Place,
  edit: (entries: EnrollmentRecord[]) => EnrollmentRecord[],
) {
  holdProject(place, () => {
    const entries = edit(appliedEnrollments(place));
    const file = path(place);
    if (!entries.length) {
      removeSecretFile(file);
      return;
    }
    writeSecretFile(file, `${JSON.stringify(entries)}\n`);
  });
}

export const sameDestination = (
  a: EnrollmentDestination,
  b: EnrollmentDestination,
) =>
  a.origin === b.origin &&
  a.workspace === b.workspace &&
  a.environment === b.environment &&
  a.projectId === b.projectId;

export function rememberIntent(
  place: Place,
  intent: EnrollmentIntent,
  confirmed = false,
) {
  update(place, (entries) => [
    ...entries.filter((entry) => !confirmed || !sameDestination(entry, intent)),
    intentShape.parse(intent),
  ]);
}

export function rememberEnrollment(place: Place, binding: AppliedEnrollment) {
  update(place, (entries) => [
    ...entries.filter((entry) => !sameDestination(entry, binding)),
    bindingShape.parse(binding),
  ]);
}

export function forgetEnrollment(place: Place, binding: EnrollmentRecord) {
  update(place, (entries) =>
    entries.filter((entry) => {
      if (!sameDestination(entry, binding)) return true;
      if ("credential" in binding)
        return (
          !("credential" in entry) || entry.credential !== binding.credential
        );
      return (
        "credential" in entry ||
        entry.installationId !== binding.installationId ||
        entry.generation !== binding.generation
      );
    }),
  );
}
