import { randomUUID } from "node:crypto";
import type { readHostCredential } from "@nodrail/policy-engine/command-line";
import {
  ApiError,
  NodrailApi,
  type LiveRules,
  type Preview,
  type ProjectApply,
} from "../api.ts";
import { resolveToken } from "../config.ts";
import { describeFailure, type Io } from "../io.ts";
import type { Lock } from "../project/lockfile.ts";
import { revisionBindings } from "../project/revision-bindings.ts";
import { revisionBody } from "../commands/workspace.ts";
import { connectUrl } from "./connect.ts";
import type { AppliedEnrollment } from "./applied-enrollment.ts";
import { EFFECTIVE_FILE } from "./claude-code.ts";
import { planEnrollment } from "./plan-enrollment.ts";
import type { Check, SetupPlan } from "./plan.ts";

type Destination = {
  api: NodrailApi;
  binding: Parameters<typeof readHostCredential>[1];
};
export type Publication = Destination & { body: ProjectApply };
type Submission = Pick<ProjectApply, "yaml" | "declarations" | "intended">;

type PolicyState = {
  checks: Check[];
  publish: Publication | null;
  changes?: SetupPlan["remoteChanges"];
  enrolled?: AppliedEnrollment;
};

const short = (digest: string) => digest.slice(0, 12);
const check = (name: string, detail: string, ok = true): Check => ({
  name,
  detail,
  ok,
});
const fail = (
  detail: string,
  changes?: SetupPlan["remoteChanges"],
): PolicyState => ({
  checks: [check("live policy", detail, false)],
  publish: null,
  changes,
});

function matchesPolicy(live: LiveRules, intended: ProjectApply["intended"]) {
  return (
    live.managed?.project_id === intended.project_id &&
    live.managed.policy_revision === intended.policy_revision &&
    live.source_digest === intended.policy_revision &&
    live.managed_agent_keys !== null
  );
}

function publishedLock(live: LiveRules, intended: ProjectApply["intended"]) {
  return (
    live.managed?.revision === intended.revision &&
    matchesPolicy(live, intended)
  );
}

async function canReadPublishedLock(
  api: NodrailApi,
  live: LiveRules,
  intended: ProjectApply["intended"],
  writer: boolean,
) {
  if (publishedLock(live, intended)) return true;
  if (writer || !matchesPolicy(live, intended)) return false;
  // A host-only lock can reuse a published policy even for a read-only plan.
  const confirmed = await api
    .liveRules(intended.revision)
    .catch((error: unknown) => {
      if (error instanceof ApiError && error.status === 400) return null;
      throw error;
    });
  return (
    confirmed?.workspace_lock_current === true &&
    matchesPolicy(confirmed, intended)
  );
}

/** Shared read-only preflight for plan and apply. */
export async function livePolicy(
  plan: SetupPlan,
  io: Pick<Io, "env" | "home" | "fetch">,
  root: string,
  { replaceLive, proposedLock }: { replaceLive: boolean; proposedLock?: Lock },
): Promise<PolicyState> {
  const { connect, projectId } = plan;
  if (connect?.decide !== "cloud") return { checks: [], publish: null };
  if (!projectId)
    return fail(
      `Add id: ${randomUUID()} to nodrail.yaml, then run nodrail policy lock.`,
    );
  const effective = plan.files.find((file) => file.path === EFFECTIVE_FILE);
  if (!effective || !plan.revision.workspace || !plan.revision.policy)
    return fail(
      "Run nodrail policy lock to lock the connected project's policy.",
    );
  const { workspace, environment } = connect;
  if (!workspace || !environment)
    return fail(
      "Set connect.workspace and connect.environment from the console.",
    );
  const origin = connectUrl(connect);
  const binding = { origin, workspace, environment, projectId };
  const token = await resolveToken(io.env, io.home, origin, workspace);
  if (!token)
    return fail(
      `Sign in to ${origin} with nodrail login --url ${origin}, then rerun plan.`,
    );
  const api = new NodrailApi({
    url: origin,
    token,
    workspace,
    environment,
    fetch: io.fetch,
  });
  try {
    const yaml = effective.content.toString("utf8");
    return await compare(
      { api, binding },
      {
        yaml,
        declarations: declarationsOf(projectId, plan.agents),
        intended: {
          ...revisionBody(
            root,
            proposedLock && { lock: proposedLock, projectId },
          ),
          entry_agent: plan.entry,
          ...revisionBindings(plan.contracts, yaml),
        },
      },
      {
        home: io.home,
        runtime: plan.runtime,
        enroll: !connect.credential,
        replaceLive,
      },
    );
  } catch (error) {
    return fail(
      `${origin} · ${workspace}/${environment}: ${describeFailure(error)}`,
    );
  }
}

const needsWriter = (what: string) =>
  `${what} requires rules:write. Sign in as a policy manager or workspace admin, or use a personal token with rules:write.`;

function declarationsOf(projectId: string, agents: SetupPlan["agents"]) {
  return {
    project_id: projectId,
    agents: agents
      .map(({ name, description }) => ({
        key: name,
        description:
          description?.slice(0, 200).replace(/[\uD800-\uDBFF]$/, "") ?? null,
      }))
      .sort((a, b) => a.key.localeCompare(b.key)),
  };
}

async function reviewPolicy(
  { api, binding }: Destination,
  { intended, yaml, declarations }: Submission,
) {
  const { workspace } = binding;
  const me = await api.me();
  if (me.workspace.slug !== workspace)
    return {
      failure: fail(
        `Sign in with access to workspace ${workspace} at ${api.url}.`,
      ),
    };
  const live = await api.liveRules();
  const writer =
    me.effective_scopes?.includes("rules:write") ?? me.can.rules_write;
  const inSync = await canReadPublishedLock(api, live, intended, writer);
  if ((!inSync || intended.contracts || intended.evidence) && !writer)
    return {
      failure: fail(needsWriter("Previewing and publishing this lock")),
    };
  const hasBindings = !!(intended.contracts || intended.evidence);
  const preview =
    inSync && !hasBindings
      ? null
      : await api.previewRules(yaml, declarations, intended);
  if (preview && preview.policy_revision !== live.policy_revision)
    return {
      failure: fail(
        "The live policy changed while planning. Run nodrail plan again.",
        preview,
      ),
    };
  if (preview?.issues.length)
    return {
      failure: fail(
        preview.issues
          .map(({ message, line }) =>
            line ? `${message} (line ${line})` : message,
          )
          .join("\n"),
        preview,
      ),
    };
  return { live, inSync, preview, writer };
}

async function compare(
  where: Destination,
  submission: Submission,
  {
    home,
    runtime,
    enroll,
    replaceLive,
  }: {
    home: string;
    runtime: SetupPlan["runtime"];
    enroll: boolean;
    replaceLive: boolean;
  },
): Promise<PolicyState> {
  const reviewed = await reviewPolicy(where, submission);
  if (reviewed.failure) return reviewed.failure;
  const { live, inSync, preview, writer } = reviewed;
  const { intended } = submission;
  const checks = policyChecks(
    { live, preview, intended, environment: where.binding.environment },
    replaceLive,
  );
  const machineCheck = enroll
    ? planEnrollment(where, runtime, home).catch((error: unknown) => ({
        failure: describeFailure(error),
      }))
    : undefined;
  const [machine, { revision }] = await Promise.all([
    machineCheck,
    where.api.intendedRevision(where.binding.projectId),
  ]);
  if (machine && "failure" in machine)
    return fail(machine.failure, preview ?? undefined);
  const needsEnrollment = !!machine && !machine.ready;
  if (needsEnrollment)
    checks.push(enrollmentCheck(machine, where.binding, writer));
  const needsIntended = !sameRevision(revision, intended, writer);
  if (needsIntended) checks.push(intendedCheck(intended.revision, writer));
  return {
    checks,
    changes: preview ?? undefined,
    enrolled: machine?.enrolled,
    publish: publication(where, submission, {
      live,
      preview,
      machine: machine?.input,
      replaceLive,
      needed:
        (!inSync && requiresApply(preview)) || needsIntended || needsEnrollment,
    }),
  };
}

function requiresApply(preview: Preview | null) {
  return (
    preview?.publishes_policy !== false ||
    preview.workspace_lock_current === false ||
    Object.values(preview.agent_changes ?? {}).some((names) => names.length > 0)
  );
}

function publication(
  where: Destination,
  submission: Submission,
  options: {
    live: LiveRules;
    preview: Preview | null;
    machine: ProjectApply["machine"];
    replaceLive: boolean;
    needed: boolean;
  },
): Publication | null {
  const { live, preview, machine, replaceLive, needed } = options;
  const { contracts, evidence } = submission.intended;
  const needsPins = !!(contracts || evidence) && !preview?.pins_current;
  if (!needed && !needsPins) return null;
  return {
    ...where,
    body: {
      ...submission,
      policy_revision: live.policy_revision,
      file_digest: preview?.file_digest,
      replace_live: replaceLive || undefined,
      machine,
    },
  };
}

function policyChecks(
  state: Parameters<typeof policyDetail>[0],
  replaceLive: boolean,
) {
  const { live, preview } = state;
  const checks = [check("live policy", policyDetail(state))];
  if (
    preview &&
    !replaceLive &&
    (preview.takeover || (!live.managed && preview.removed.length))
  )
    checks.push(
      check(
        "replace live policy",
        "Review the changes and run nodrail plan --replace-live to proceed.",
        false,
      ),
    );
  return checks;
}

function intendedCheck(revision: string, writer: boolean) {
  return check(
    "intended revision",
    writer
      ? `Apply records lock ${short(revision)} as the intended revision.`
      : needsWriter("Recording the intended revision"),
    writer,
  );
}

function sameRevision(
  current: Pick<
    Submission["intended"],
    "revision" | "policy_revision" | "entry_agent"
  > | null,
  intended: Submission["intended"],
  writer: boolean,
) {
  return (
    current?.revision === intended.revision &&
    current.policy_revision === intended.policy_revision &&
    (!writer || current.entry_agent === intended.entry_agent)
  );
}

function enrollmentCheck(
  machine: { valid: boolean; current: string | null },
  { workspace, environment }: Destination["binding"],
  writer: boolean,
) {
  const action = machine.valid
    ? "refreshes this machine's agent keys and credential scopes"
    : machine.current
      ? "rotates this machine's credential"
      : "enrolls this machine";
  return check(
    "machine enrollment",
    writer
      ? `Apply ${action} in ${workspace}/${environment}.`
      : needsWriter("Enrolling this machine"),
    writer,
  );
}

function policyDetail({
  live,
  preview,
  intended,
  environment,
}: {
  live: LiveRules;
  preview: Preview | null;
  intended: ProjectApply["intended"];
  environment: string;
}) {
  const policy = `${environment} policy v${live.policy_revision}`;
  if (!preview || publishedLock(live, intended))
    return `In sync. ${policy} serves lock ${short(intended.revision)}.`;
  if (preview.publishes_policy === false)
    return `Apply keeps policy v${live.policy_revision} in ${environment}.`;
  const { added, changed, removed } = preview.policy_counts ?? {
    added: preview.added.filter((item) => !item.startsWith("agent ")).length,
    changed: preview.changed.filter((item) => !item.startsWith("agent "))
      .length,
    removed: preview.removed.length,
  };
  const counts = `${added} added, ${changed} changed, ${removed} removed`;
  const next = `Apply publishes policy v${live.policy_revision + 1}: ${counts}`;
  return preview.takeover
    ? `${next}. Takes over from project ${preview.takeover.project_id}.`
    : `${next}.`;
}
