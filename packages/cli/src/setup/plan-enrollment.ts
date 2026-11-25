import { randomUUID } from "node:crypto";
import { readHostCredential } from "@nodrail/policy-engine/command-line";
import type { NodrailApi } from "../api.ts";
import { generationOf } from "./applied-enrollment.ts";
import { readMachineId } from "./machine.ts";
import type { SetupPlan } from "./plan.ts";

export async function planEnrollment(
  {
    api,
    binding,
  }: { api: NodrailApi; binding: Parameters<typeof readHostCredential>[1] },
  runtime: SetupPlan["runtime"],
  home: string,
) {
  const id = await readMachineId(home);
  const saved = await readHostCredential(home, binding);
  const machine = {
    id: id ?? randomUUID(),
    runtime,
    credential: saved?.credential,
  };
  const status = id
    ? await api.enrollmentStatus(binding.projectId, machine)
    : {
        valid: false,
        fresh: false,
        installation_id: null,
        current_credential: null,
      };
  const valid =
    status.valid && status.installation_id === saved?.installationId;
  return {
    valid,
    enrolled:
      valid && saved
        ? {
            ...binding,
            installationId: saved.installationId,
            generation: generationOf(saved.credential),
          }
        : undefined,
    ready: valid && status.fresh,
    current: status.current_credential,
    input: {
      ...machine,
      credential:
        status.valid && status.installation_id !== saved?.installationId
          ? undefined
          : machine.credential,
      expected_credential: status.current_credential,
    },
  };
}
