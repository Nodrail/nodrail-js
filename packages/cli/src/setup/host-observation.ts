import { join } from "node:path";
import {
  controlPlaneOrigin,
  hookCredential,
  readHookConnection,
} from "@nodrail/policy-engine/command-line";
import type { Io } from "../io.ts";
import { CONNECT_FILE } from "./connect.ts";
import { hostStatuses, observation, type Observation } from "./observe.ts";
import type { SetupPlan } from "./plan.ts";

/** Send only the public fields of an observation to the enrolled connection. */
export async function sendHostObservation(
  { home, env, fetch: send = fetch }: Pick<Io, "home" | "env" | "fetch">,
  root: string,
  record: Observation,
) {
  const settings = readHookConnection(join(root, CONNECT_FILE), true);
  if (settings.decide !== "cloud" || !settings.project_id) return;
  const credential = await hookCredential(settings, env, home);
  const url = controlPlaneOrigin(settings.url);
  const responses = await Promise.all(
    record.hosts.map((host) =>
      send(`${url}/api/v1/runtime/inventory`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${credential}`,
          "content-type": "application/json",
        },
        redirect: "error",
        signal: AbortSignal.timeout(3_000),
        body: JSON.stringify({
          host: host.host,
          agent: host.entry ?? undefined,
          applied_revision: host.revision.applied,
          locked_revision: host.revision.locked,
          in_step: record.inStep,
          activation: host.activation,
          drift: host.drift,
          unmanaged: host.unmanaged,
          ...(host.names
            ? {
                names: {
                  drift: host.names.drift
                    .slice(0, 20)
                    .map((name) => name.slice(0, 200)),
                  unmanaged: host.names.unmanaged
                    .slice(0, 20)
                    .map((name) => name.slice(0, 200)),
                },
              }
            : {}),
        }),
      }),
    ),
  );
  if (responses.some((response) => !response.ok))
    throw new Error("Inventory report refused");
}

/** Apply reports the configured setup immediately; session starts refresh it. */
export async function reportAppliedHost(io: Io, root: string, plan: SetupPlan) {
  if (plan.connect?.decide !== "cloud" || plan.connect.credential) return;
  try {
    const statuses = await hostStatuses(
      { root, home: io.home, env: io.env },
      plan.runtime,
    );
    await sendHostObservation(
      io,
      root,
      observation(root, statuses, plan.observeNames),
    );
  } catch {
    return "Could not report this machine to Inventory. Run nodrail apply again when the control plane is reachable.";
  }
}
