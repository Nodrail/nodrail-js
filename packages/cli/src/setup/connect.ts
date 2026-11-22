import type { ProjectSetup } from "@nodrail/policy-engine/yaml";
import { secretName, secretValue } from "@nodrail/policy-engine/command-line";
import { DEFAULT_URL } from "../api.ts";
import { normalizeUrl, type Env } from "../config.ts";
import { VERSION } from "../version.ts";
import type { Check } from "./plan.ts";

/**
 * `connect:` in plan (R383): who decides, said in words, and what this
 * version can't do yet, marked so apply refuses instead of pretending.
 */

type Connect = NonNullable<ProjectSetup["connect"]>;

/** The Nodrail `connect:` names: Cloud when it gives no address. */
export const connectUrl = (connect: Connect) =>
  normalizeUrl(connect.url ?? DEFAULT_URL);

const where = (connect: Connect) =>
  `${connectUrl(connect)}, workspace ${connect.workspace}, environment ${connect.environment}`;

/** What plan says about the connection beside its steps. */
export function connectNotes(setup: Pick<ProjectSetup, "connect">): string[] {
  const { connect } = setup;
  if (!connect) return [];
  return connect.decide === "cloud"
    ? [
        `Connected to ${where(connect)}. Decisions: Nodrail. Views: its Runs and Activity.`,
      ]
    : [
        `Connected to ${where(connect)}, but decisions stay on this machine (decide: local).`,
      ];
}

/**
 * What this version can't do yet. Each is a check that fails, so apply
 * refuses rather than set up something that silently decides locally.
 */
export function connectChecks(
  setup: Pick<ProjectSetup, "connect">,
  runtime: string,
): Check[] {
  const { connect } = setup;
  if (!connect) return [];
  const checks: Check[] = [];
  if (connect.decide === "cloud" && runtime !== "claude-code")
    checks.push({
      name: "connect",
      ok: false,
      detail: `decide: cloud sets up Claude Code only in nodrail ${VERSION}: ${runtime} isn't connected yet. Use decide: local for it`,
    });
  if (connect.enforce === "watch")
    checks.push({
      name: "connect",
      ok: false,
      detail: `enforce: watch isn't available in nodrail ${VERSION} yet: nothing would record without blocking. Use enforce: on until it ships`,
    });
  return checks;
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
  if (!connect?.credential) return [];
  const name = `credential ${secretName(connect.credential)}`;
  let credential: string;
  try {
    credential = secretValue(connect.credential, env);
  } catch (error) {
    return [
      {
        name,
        ok: false,
        detail: `${(error as Error).message}: the hook needs it to ask Nodrail. Copy it from Agents → Connect an agent`,
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
  return { identity: (await response.json()) as Identity };
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
