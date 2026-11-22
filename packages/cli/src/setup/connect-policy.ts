import {
  NodrailApi,
  type LiveRules,
  type ManagedSource,
  type Preview,
} from "../api.ts";
import { resolveToken, type Env } from "../config.ts";
import { connectUrl } from "./connect.ts";
import { EFFECTIVE_FILE } from "./claude-code.ts";
import type { Check, SetupPlan } from "./plan.ts";

/**
 * With `decide: cloud`, the locked policy is what Nodrail must run (R383).
 * plan compares the live version with the lock, as the person's own token
 * sees it (an agent never holds one); apply publishes it, refusing to take
 * over rules changed elsewhere unless asked to (R385).
 */

type Plan = Pick<SetupPlan, "connect" | "projectId" | "revision" | "files">;

/** What apply would publish, ready to send. */
export type Publication = {
  api: NodrailApi;
  yaml: string;
  preview: Preview;
  managed: ManagedSource;
};

export type PolicyState = { checks: Check[]; publish: Publication | null };

const short = (digest: string | null | undefined) =>
  digest ? digest.slice(0, 12) : "none";

const fail = (detail: string): PolicyState => ({
  checks: [{ name: "live policy", ok: false, detail }],
  publish: null,
});

/** Where the plan's policy stands against what is live in the environment. */
export async function livePolicy(
  plan: Plan,
  io: { env: Env; home: string; fetch?: typeof fetch },
  options: {
    replaceLive?: boolean;
    /**
     * apply: what can't be checked blocks, so the hook that asks Nodrail is
     * never installed against rules nobody compared with the lock.
     */
    required?: boolean;
  } = {},
): Promise<PolicyState> {
  const state = await liveState(plan, io, options);
  if (!options.required) return state;
  return {
    ...state,
    checks: state.checks.map((check) =>
      check.unverified
        ? {
            name: check.name,
            ok: false,
            detail: `${check.detail}. apply needs it checked before it installs the hook that asks Nodrail`,
          }
        : check,
    ),
  };
}

async function liveState(
  plan: Plan,
  io: { env: Env; home: string; fetch?: typeof fetch },
  options: { replaceLive?: boolean },
): Promise<PolicyState> {
  const { connect } = plan;
  if (connect?.decide !== "cloud") return { checks: [], publish: null };
  if (!plan.projectId)
    return fail(
      "decide: cloud ties the policy Nodrail runs to this project: add `id: <uuid>` to nodrail.yaml, lock and commit",
    );
  const effective = plan.files.find((file) => file.path === EFFECTIVE_FILE);
  if (!effective || !plan.revision.workspace)
    return fail(
      "there's no locked policy to publish: run `nodrail policy lock`",
    );
  const url = connectUrl(connect);
  const token = await resolveToken(io.env, io.home, url);
  if (!token)
    return {
      checks: [
        {
          name: "live policy",
          ok: true,
          unverified: true,
          detail: `not checked: no token for ${url} here. Run \`nodrail login --url ${url}\` with your own token (rules:write to publish)`,
        },
      ],
      publish: null,
    };
  const api = new NodrailApi({
    url,
    token,
    environment: connect.environment,
    fetch: io.fetch,
  });
  try {
    return await compare(
      plan,
      api,
      effective.content.toString("utf8"),
      options,
    );
  } catch (error) {
    return {
      checks: [
        {
          name: "live policy",
          ok: true,
          unverified: true,
          detail: `not checked: ${url} couldn't be asked (${(error as Error).message})`,
        },
      ],
      publish: null,
    };
  }
}

async function compare(
  plan: Plan,
  api: NodrailApi,
  yaml: string,
  options: { replaceLive?: boolean },
): Promise<PolicyState> {
  const connect = plan.connect!;
  const me = await api.me();
  if (me.workspace.slug !== connect.workspace)
    return fail(
      `your token is for workspace ${me.workspace.slug}, not ${connect.workspace}: log in with a token from ${connect.workspace}`,
    );
  const managed: ManagedSource = {
    project_id: plan.projectId!,
    revision: plan.revision.workspace!,
    policy_revision: plan.revision.policy,
  };
  const live = await api.liveRules();
  const drift = driftOf(live, managed);
  if (drift && !options.replaceLive) return fail(drift);
  const preview = await api.previewRules(yaml);
  if (preview.issues.length > 0)
    return fail(
      `${connect.environment} would refuse the locked policy: ${preview.issues[0]!.message} (line ${preview.issues[0]!.line})`,
    );
  const inSync = live.managed?.revision === managed.revision;
  const writer = me.can.rules_write
    ? null
    : "your token can't publish (it needs rules:write)";
  return {
    checks: [
      {
        name: "live policy",
        ok: inSync || writer === null,
        detail: inSync
          ? `in sync: ${connect.environment} runs lock ${short(managed.revision)} (v${live.policy_revision}, ${live.published_by ?? "someone"})`
          : (writer ??
            `apply publishes lock ${short(managed.revision)} to ${connect.environment}: ${preview.added.length} added, ${preview.changed.length} changed, ${preview.removed.length} removed${drift ? `, replacing rules changed elsewhere (${drift})` : ""}`),
      },
    ],
    publish: inSync ? null : { api, yaml, preview, managed },
  };
}

/** Why the live rules aren't this project's to replace, or null. */
function driftOf(live: LiveRules, managed: ManagedSource): string | null {
  if (live.policy_revision === 0) return null;
  if (live.managed?.project_id === managed.project_id) return null;
  const who = `v${live.policy_revision}, published by ${live.published_by ?? "someone"}${live.published_at ? ` at ${live.published_at}` : ""}`;
  return live.managed
    ? `the live rules (${who}) come from another project (${live.managed.project_id}). apply --replace-live takes them over`
    : `the live rules (${who}) were changed in Nodrail, not published from this repo. Bring the change into the repo, or apply --replace-live to replace it`;
}

/** Publishes what plan showed; a change made in between is refused. */
export async function publishPolicy(publication: Publication) {
  const { api, yaml, preview, managed } = publication;
  return api.publishRules(yaml, preview, managed);
}
