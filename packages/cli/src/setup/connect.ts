import type { ProjectSetup } from "@nodrail/policy-engine/yaml";
import { secretName, secretValue } from "@nodrail/policy-engine/command-line";
import { DEFAULT_URL } from "../api.ts";
import { normalizeUrl, type Env } from "../config.ts";
import { LOCK_FILE } from "../project/lockfile.ts";
import { VERSION } from "../version.ts";
import type { Check } from "./plan.ts";
import type { Revision } from "./status.ts";
import type { DesiredFile } from "./team-files.ts";

type Connect = NonNullable<ProjectSetup["connect"]>;

/** The Nodrail `connect:` names: Cloud when it gives no address. */
export const connectUrl = (connect: Connect) =>
  normalizeUrl(connect.url ?? DEFAULT_URL);

const where = (connect: Connect) =>
  `${connectUrl(connect)}, workspace ${connect.workspace}, environment ${connect.environment}`;

export const CONNECT_FILE = ".nodrail/connect.json";

export const connectRead = (
  setup: { connect?: Connect | null },
  path: (file: string) => string,
) => (setup.connect ? ` --connect ${path(CONNECT_FILE)}` : "");

export function connectFile(
  connect: Connect | null,
  revision: Revision,
): DesiredFile | null {
  if (!connect) return null;
  const { decide, enforce } = connect;
  const settings = {
    decide,
    enforce,
    ...(decide === "cloud"
      ? {
          url: connectUrl(connect),
          workspace: connect.workspace,
          environment: connect.environment,
          credential: connect.credential,
          workspace_revision: revision.workspace,
          policy_digest: revision.policy,
          lock: `../${LOCK_FILE}`,
        }
      : {}),
  };
  return {
    path: CONNECT_FILE,
    content: Buffer.from(`${JSON.stringify(settings, null, 2)}\n`),
    why:
      decide === "cloud"
        ? "pin the policy the host pulls, and configure evidence and decision reporting"
        : "set how the host enforces repository policy",
  };
}

/** What plan says about the connection beside its steps. */
export function connectNotes(setup: Pick<ProjectSetup, "connect">): string[] {
  const { connect } = setup;
  if (!connect) return [];
  return [
    connect.decide === "cloud"
      ? `The host decides using the locked policy pulled from ${where(connect)}. Decisions go to Runs and Activity.`
      : "The host decides using repository policy (decide: local).",
    ...(connect.enforce === "watch"
      ? ["Watch mode records policy decisions and lets the host continue."]
      : []),
  ];
}

type Identity = { workspace: string; environment: string; agent: string };

/** How long plan waits for Nodrail before it says it couldn't check. */
export const IDENTITY_TIMEOUT_MS = 5_000;

/**
 * Whether the credential is set, accepted, and for the workspace and
 * environment `connect:` names. It's never printed or written. An answer
 * that can't be had (offline, slow) leaves it unverified, not failed.
 */
export async function credentialChecks(
  setup: Pick<ProjectSetup, "connect">,
  env: Env,
  fetcher: typeof fetch = fetch,
): Promise<Check[]> {
  const { connect } = setup;
  if (connect?.decide !== "cloud" || !connect.credential) return [];
  const name = `credential ${secretName(connect.credential)}`;
  let credential: string;
  try {
    credential = secretValue(connect.credential, env);
  } catch (error) {
    return [
      {
        name,
        ok: false,
        detail: `${(error as Error).message}: the hook needs it to fetch policy, read evidence and report decisions. Copy it from Agents → Connect an agent`,
      },
    ];
  }
  const answer = await askIdentity(connect, credential, fetcher);
  return [
    "identity" in answer
      ? compared(connect, answer.identity, name)
      : { name, ...answer },
  ];
}

/** Nodrail's answer about the credential, or why there is none. */
async function askIdentity(
  connect: Connect,
  credential: string,
  fetcher: typeof fetch,
): Promise<{ identity: Identity } | Omit<Check, "name">> {
  const base = connectUrl(connect);
  const unchecked = (why: string) => ({
    ok: true,
    unverified: true,
    detail: `set, not checked: ${base} ${why}`,
  });
  let response: Response;
  try {
    response = await fetcher(`${base}/api/v1/runtime/identity`, {
      headers: { authorization: `Bearer ${credential}` },
      signal: AbortSignal.timeout(IDENTITY_TIMEOUT_MS),
      redirect: "error",
    });
  } catch (error) {
    return unchecked(`didn't answer (${(error as Error).message})`);
  }
  if (response.status === 401 || response.status === 403)
    return {
      ok: false,
      detail: `refused by ${base}: it's revoked, expired or for another Nodrail. Make a new one under Agents`,
    };
  if (response.status === 404)
    return unchecked(
      `is older than nodrail ${VERSION} and can't say whose credential this is`,
    );
  if (!response.ok) return unchecked(`answered ${response.status}`);
  const identity = (await response
    .json()
    .catch(() => null)) as Partial<Identity> | null;
  if (
    typeof identity?.workspace !== "string" ||
    typeof identity.environment !== "string" ||
    typeof identity.agent !== "string"
  )
    return unchecked("returned an invalid identity");
  return {
    identity: {
      workspace: identity.workspace,
      environment: identity.environment,
      agent: identity.agent,
    },
  };
}

/** Whether the credential is for the workspace and environment named. */
function compared(connect: Connect, identity: Identity, name: string): Check {
  const wrong = [
    identity.workspace !== connect.workspace
      ? `workspace ${identity.workspace}, not ${connect.workspace}`
      : "",
    identity.environment !== connect.environment
      ? `environment ${identity.environment}, not ${connect.environment}`
      : "",
  ].filter(Boolean);
  return wrong.length > 0
    ? {
        name,
        ok: false,
        detail: `it's agent ${identity.agent}'s, for ${wrong.join(" and ")}: fix connect: or use that environment's credential`,
      }
    : {
        name,
        ok: true,
        detail: `accepted: agent ${identity.agent} in ${connect.workspace}/${connect.environment}`,
      };
}
