import { randomUUID } from "node:crypto";
import { z } from "zod";
import { callKey } from "./decision-report.ts";
import { callerCandidate } from "./hook-caller.ts";
import type { RemoteConfig } from "./evidence-remote.ts";
import type { HookConnection } from "./hook-connection.ts";
import { policyRefusal } from "./hook-policy-error.ts";
import { parseEvent } from "./local-hook.ts";

const accessReply = z.object({
  agent: z.string().min(1),
  paused: z.boolean(),
  admission_id: z.string().optional(),
  paused_agents: z.array(z.string()).optional(),
  reason: z.string().optional(),
  workspace: z.string(),
  environment: z.string(),
  project_id: z.uuid().nullable(),
});
const unavailable =
  "Nodrail: fresh agent access status is unavailable, so this connected call is blocked. Restore connectivity to the control plane.";

export function accessChecks(
  config: RemoteConfig | null | undefined,
  settings: HookConnection | null,
  entry?: string,
  host = "claude-code",
) {
  return async (
    stdin: string,
  ): Promise<{
    caller?: string;
    accessRefusal?: string;
    pausedAgents?: string[];
    admission?: { id: string; call: string };
  }> => {
    if (!config || settings?.decide !== "cloud") return {};
    const event = parseEvent(stdin) ?? {};
    // The configured entry names the root session. An unnamed delegate has no declared identity.
    const agent =
      callerCandidate(event) ?? (event.agent_id ? undefined : entry);
    const call = callKey(host, event) ?? `${host}:${randomUUID()}`;
    return checkAccess(config, settings, call, agent);
  };
}

async function checkAccess(
  config: RemoteConfig,
  settings: Extract<HookConnection, { decide: "cloud" }>,
  call: string,
  agent: string | undefined,
) {
  const query = new URLSearchParams({
    call,
    policy_digest: settings.policy_digest,
    workspace_revision: settings.workspace_revision,
    ...(agent ? { agent } : {}),
  });
  try {
    const response = await (config.fetch ?? fetch)(
      `${config.url}/api/v1/runtime/access?${query}`,
      {
        headers: { authorization: `Bearer ${config.token}` },
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(3_000),
      },
    );
    if (!response.ok)
      return { accessRefusal: (await policyRefusal(response)) ?? unavailable };
    const access = accessReply.parse(await response.json());
    if (
      access.workspace !== settings.workspace ||
      access.environment !== settings.environment ||
      (access.project_id !== null && access.project_id !== settings.project_id)
    )
      return {
        accessRefusal:
          "Nodrail: this credential belongs to a different project or environment. Run nodrail apply.",
      };
    return {
      caller: access.agent,
      ...(access.admission_id
        ? { admission: { id: access.admission_id, call } }
        : {}),
      ...(access.paused
        ? {
            pausedAgents: access.paused_agents?.length
              ? access.paused_agents
              : [access.agent],
            accessRefusal: `Nodrail: ${access.reason ?? `access for ${access.agent} is paused.`}`,
          }
        : {}),
    };
  } catch {
    return { accessRefusal: unavailable };
  }
}
