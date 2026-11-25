import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  controlPlaneOrigin,
  readHostCredential,
  removeHostCredential,
} from "@nodrail/policy-engine/command-line";
import { NodrailApi } from "../api.ts";
import { resolveToken } from "../config.ts";
import { CliError, type Io } from "../io.ts";
import type { Place } from "../project/store.ts";
import {
  forgetEnrollment,
  generationOf,
  withEnrollmentLock,
  type EnrollmentRecord,
  type EnrollmentIntent,
} from "./applied-enrollment.ts";
import { CONNECT_FILE } from "./connect.ts";
import { readMachineId } from "./machine.ts";
import type { DestroyPlan } from "./destroy.ts";

const legacyRecovery = () =>
  new CliError(
    "Legacy machine revocation is unresolved. Restore the original .nodrail/connect.json and its machine credential, then run `nodrail destroy --yes` from the project folder. If the originals are unavailable, revoke the machine in Agents → Unidentified callers → Settings → Revoke credential.",
  );

const appliedConnection = z.object({
  decide: z.literal("cloud"),
  url: z.string(),
  workspace: z.string(),
  environment: z.string(),
  project_id: z.uuid(),
  credential: z.undefined().optional(),
});

/** Upgrade older applies whose original connection file is still intact. */
export async function legacyEnrollment(
  home: string,
  root: string,
  plan: DestroyPlan,
) {
  const hashes = plan.hosts.map(
    (host) => plan.state?.hosts[host]?.files[CONNECT_FILE],
  );
  if (!hashes.some(Boolean)) return null;
  const contents = await readFile(join(root, CONNECT_FILE)).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    },
  );
  if (!contents) throw legacyRecovery();
  if (!hashes.includes(createHash("sha256").update(contents).digest("hex")))
    throw legacyRecovery();
  const config = JSON.parse(contents.toString("utf8")) as Record<
    string,
    unknown
  >;
  if (config.decide === "local" || config.credential) return null;
  const parsed = appliedConnection.safeParse(config);
  if (!parsed.success) throw legacyRecovery();
  const { url, workspace, environment, project_id: projectId } = parsed.data;
  const saved = await readHostCredential(home, {
    origin: controlPlaneOrigin(url),
    workspace,
    environment,
    projectId,
  });
  if (!saved) throw legacyRecovery();
  return {
    origin: saved.origin,
    workspace,
    environment,
    projectId,
    installationId: saved.installationId,
    generation: generationOf(saved.credential),
  };
}

async function reconcileIntent(io: Io, binding: EnrollmentIntent) {
  const token = await resolveToken(
    io.env,
    io.home,
    binding.origin,
    binding.workspace,
  );
  const machineId = binding.machineId ?? (await readMachineId(io.home));
  if (!token || !machineId) return null;
  const api = new NodrailApi({
    url: binding.origin,
    workspace: binding.workspace,
    environment: binding.environment,
    token,
    fetch: io.fetch,
  });
  const result = await api.reconcileEnrollment(
    binding.projectId,
    machineId,
    generationOf(binding.credential),
  );
  return result?.status === "revoked" || result?.status === "never_activated"
    ? result.status
    : null;
}

async function revoke(io: Io, origin: string, credential: string | undefined) {
  if (!credential) return null;
  const response = await (io.fetch ?? fetch)(
    `${origin}/api/v1/runtime/disconnect`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${credential}`,
        "content-type": "application/json",
      },
      body: "{}",
      redirect: "error",
      signal: AbortSignal.timeout(3_000),
    },
  );
  const result = (await response.json()) as { revoked?: boolean } | null;
  return response.ok && result?.revoked === true ? "revoked" : null;
}

export async function disconnect(
  io: Io,
  place: Place,
  binding: EnrollmentRecord,
) {
  const { origin, workspace, environment } = binding;
  const pending = "credential" in binding;
  const saved = await readHostCredential(io.home, binding);
  const credential = pending
    ? binding.credential
    : saved?.installationId === binding.installationId &&
        (!binding.generation ||
          binding.generation === generationOf(saved.credential))
      ? saved.credential
      : undefined;
  let status;
  try {
    status = pending
      ? await reconcileIntent(io, binding)
      : await revoke(io, origin, credential);
  } catch {
    // An uncertain reply leaves the record for a subsequent destroy.
  }
  if (!status) {
    const retry = pending
      ? `run nodrail login --url ${origin}, then run \`nodrail destroy\` again`
      : "run `nodrail destroy` again";
    return {
      error: `disconnect incomplete: ${retry} or revoke at ${origin}/app/${encodeURIComponent(workspace)}/${encodeURIComponent(environment)}/agents under Unidentified callers → Settings → Revoke credential.`,
    };
  }
  return withEnrollmentLock(place, binding, async (lock) => {
    const current = await readHostCredential(io.home, binding);
    lock.commit(() => {
      if (credential && current?.credential === credential)
        removeHostCredential(io.home, binding);
      forgetEnrollment(place, binding);
    });
    return {
      status,
      notes: [
        status === "never_activated"
          ? `Cleared an enrollment attempt that never activated at ${origin} (${workspace}/${environment}).`
          : `Disconnected this machine from ${workspace}/${environment} at ${origin}.`,
        `To end your personal CLI session, run nodrail logout --url ${origin}.`,
      ],
    };
  });
}
