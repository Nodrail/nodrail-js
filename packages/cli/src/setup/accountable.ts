// What engine level 5 (document version 4) asks of a setup: numeric budgets
// settle on a call's outcome, evidence requirements read local evidence or
// ask Cloud, and the Cloud hook needs the compiled brief and input
// contracts. Apply writes the files the hooks read; plan says what each
// budget and requirement can promise here, and refuses what this local
// setup can't enforce.
import {
  BUDGET_LABELS,
  declaredGateId,
  declaredGates,
  evidenceOf,
  type EvidenceNeed,
  type NumericBudget,
  type PolicyDocument,
} from "@nodrail/policy-engine";
import {
  ledgerDirectory,
  nodrailDirectory,
} from "@nodrail/policy-engine/hook-runs";
import { compilePolicies } from "@nodrail/policy-engine/yaml";
import type { Env } from "../config.ts";
import { resolveUrl } from "../config.ts";
import type { Runtime } from "./state.ts";
import { claudeActivation, lockedRevision } from "./status.ts";
import { PROTECT_LIST, type DesiredFile } from "./team-files.ts";

/** Where apply writes `{ url, workspace_revision }` for the hook's `--evidence`. */
export const EVIDENCE_FILE = ".nodrail/evidence.json";

/**
 * Where apply writes the compiled brief and input contracts, for
 * the Cloud hook to send `params.brief` and classified inputs as Cloud's
 * rules read them. Like connections.json: written whole, never a secret.
 */
export const CONTRACTS_FILE = ".nodrail/contracts.json";

/** The compiled effective policy, or null when it doesn't compile. */
let last: { text: string; document: PolicyDocument | null } | null = null;
export function effectiveDocument(effective: string): PolicyDocument | null {
  if (last?.text === effective) return last.document;
  const compiled = compilePolicies([
    { name: "effective.yaml", text: effective },
  ]);
  last = { text: effective, document: compiled.ok ? compiled.document : null };
  return last.document;
}

/** The numeric budgets of a version 4 document, else none. */
export const limitsIn = (document: PolicyDocument | null): NumericBudget[] =>
  document?.version === 4 ? document.limits : [];

/** Each evidence requirement with the gate it is on and its index there. */
export function evidenceNeeds(document: PolicyDocument | null) {
  if (document?.version !== 4) return [];
  return declaredGates(document.gates).flatMap((gate) =>
    evidenceOf(gate).map((need, index) => ({
      gate: declaredGateId(gate),
      gateName: gate.name,
      index,
      need,
      producers: document.evidence[need.evidence]?.producers ?? [],
    })),
  );
}

/** Whether only Cloud can meet the requirement, or Cloud can help meet it. */
const asksCloud = (producers: { class: string; verifier: string | null }[]) =>
  producers.some((p) => p.class === "externally-verified");

/** Whether local runtime-observed evidence can meet the requirement here. */
const readsLocal = (
  need: EvidenceNeed,
  producers: { class: string; verifier: string | null }[],
) =>
  need.authority !== "externally-verified" &&
  producers.some((p) => p.class === "runtime-observed");

/**
 * `{ url, workspace_revision }` for the hook's `--evidence`, when a
 * gate reads evidence a verifier produces and the lock has a workspace
 * revision to ask about. The token is the person's, from NODRAIL_TOKEN.
 */
function evidenceConfig(
  root: string,
  effective: string,
  env: Env,
): DesiredFile | null {
  if (
    !evidenceNeeds(effectiveDocument(effective)).some((n) =>
      asksCloud(n.producers),
    )
  )
    return null;
  const revision = lockedRevision(root).workspace;
  if (!revision) return null;
  let url: string;
  try {
    url = resolveUrl(env);
  } catch {
    return null;
  }
  return {
    path: EVIDENCE_FILE,
    content: Buffer.from(
      `${JSON.stringify({ url, workspace_revision: revision }, null, 2)}\n`,
    ),
    why: "where the hook asks Cloud about externally verified evidence",
  };
}

/** The briefs and inputs a version 3 or 4 document pins, or null without any. */
function contractsFile(effective: string): DesiredFile | null {
  const document = effectiveDocument(effective);
  if (document?.version !== 3 && document?.version !== 4) return null;
  const { briefs, inputs } = document;
  if (!briefs && !inputs) return null;
  const body = {
    version: 1,
    ...(briefs ? { briefs } : {}),
    ...(inputs ? { inputs } : {}),
  };
  return {
    path: CONTRACTS_FILE,
    content: Buffer.from(`${JSON.stringify(body, null, 2)}\n`),
    why: "the brief and input contracts the Cloud hook reads, to send briefs and classified inputs as Cloud's rules read them",
  };
}

/** What apply writes for level 5 and the Cloud hook; nothing for other policies. */
export function accountableFiles(input: {
  root: string;
  effective: string;
  env?: Env;
  setup?: { connect: { decide: string } | null };
}): DesiredFile[] {
  return [
    input.setup?.connect
      ? null
      : evidenceConfig(input.root, input.effective, input.env ?? {}),
    contractsFile(input.effective),
  ].filter((file): file is DesiredFile => file !== null);
}

/** The hook's `--evidence` flag, when apply writes its file. */
export function evidenceRead(
  input: { root: string; effective: string; env?: Env },
  path: (file: string) => string,
) {
  return evidenceConfig(input.root, input.effective, input.env ?? {})
    ? ` --evidence ${path(EVIDENCE_FILE)}`
    : "";
}

/** One numeric budget as plan shows it. */
export type BudgetLine = {
  id: string;
  name: string;
  label: string;
  unit: string;
  limit: number;
  per: NumericBudget["per"];
  timezone: string | null;
  across: NumericBudget["across"];
  counts: string;
  /** Who enforces it here, or why nothing does. */
  enforced: string;
  /** Why it can't be activated here, or null. */
  failure: string | null;
};

/** One evidence requirement as plan shows it. */
export type EvidenceLine = {
  gate: string;
  index: number;
  evidence: string;
  authority: EvidenceNeed["authority"];
  producers: string[];
  /** The verifiers it depends on, by name. */
  verifiers: string[];
  /** Where it is read from here. */
  read: string;
  failure: string | null;
};

const SHARED =
  "shared budgets need a shared budget authority; the hook would deny every call they cover";
const NO_GUARD =
  "runtime-observed evidence needs the setup guard, so agents can't run `nodrail evidence run` themselves or write the run ledger";

/** What a budget counts, in words. */
function counts(budget: NumericBudget) {
  const { measure } = budget;
  if (measure.kind === "count")
    return `calls of ${measure.tool} ${measure.operation}`;
  if (measure.kind === "sum")
    return `${measure.path} of ${measure.tool} ${measure.operation}`;
  return "subagent tokens the host measured";
}

/** A budget's window in words: per step, per run, per day in its time zone. */
export const windowOf = (budget: {
  per: NumericBudget["per"];
  timezone: string | null;
}) =>
  budget.per === "day" ? `per day (${budget.timezone})` : `per ${budget.per}`;

/** A budget in one line: label, limit, window, scope. */
export const budgetText = (line: BudgetLine) =>
  `${line.name}: ${line.limit} ${line.unit} ${windowOf(line)}, across ${line.across} · ${line.label}; counts ${line.counts}; ${line.failure ? `! ${line.failure}` : line.enforced}`;

/** A requirement in one line: gate, evidence, authority, where it is read. */
export const evidenceText = (line: EvidenceLine) =>
  `gate ${line.gate} #${line.index + 1}: ${line.evidence}, ${line.authority}; producers ${line.producers.join(", ")}; ${line.failure ? `! ${line.failure}` : line.read}`;

/** What plan shows of numeric budgets and evidence requirements. */
export type Accountable = { budgets: BudgetLine[]; evidence: EvidenceLine[] };

function planBudget(budget: NumericBudget, connected: boolean): BudgetLine {
  return {
    id: budget.id,
    name: budget.name,
    label: BUDGET_LABELS[budget.label],
    unit: budget.unit,
    limit: budget.limit,
    per: budget.per,
    timezone: budget.timezone,
    across: budget.across,
    counts: counts(budget),
    enforced:
      budget.across === "environment"
        ? "shared budget authority"
        : budget.source === "admission"
          ? `the local hook reserves before each call (${windowOf(budget)}), settled on PostToolUse`
          : `the local hook stops further work at the limit (${windowOf(budget)}); a step without a reading is unknown and holds`,
    failure: budget.across === "environment" && !connected ? SHARED : null,
  };
}

/**
 * Each numeric budget and evidence requirement of the effective policy, as
 * this local setup enforces them. `guard`: whether the setup guard (the
 * protect list in the hook, with hooks on) is active for this host.
 */
export function accountablePlan(input: {
  effective: string;
  guard: { active: boolean; detail: string };
  /** Whether the hook gets `--evidence`, so Cloud can be asked. */
  cloud: boolean;
  connected?: "cloud" | "local";
}) {
  const document = effectiveDocument(input.effective);
  const budgets = limitsIn(document).map((budget) =>
    planBudget(budget, input.connected === "cloud"),
  );
  const evidence: EvidenceLine[] = evidenceNeeds(document).map(
    ({ gate, index, need, producers }) => {
      const local = readsLocal(need, producers);
      const cloud = asksCloud(producers);
      const read = [
        ...(local
          ? [`local evidence from \`nodrail evidence run ${need.evidence}\``]
          : []),
        ...(cloud
          ? [
              input.connected === "cloud"
                ? "the control plane, using the host credential for the published workspace revision"
                : input.connected === "local"
                  ? "external evidence is unavailable in decide: local"
                  : input.cloud
                    ? "Cloud's answer for the published workspace revision (NODRAIL_TOKEN with read)"
                    : "Cloud, once the lock has a workspace revision (until then unmet here)",
            ]
          : []),
      ];
      return {
        gate,
        index,
        evidence: need.evidence,
        authority: need.authority,
        producers: producers.map((p) =>
          p.verifier ? `${p.class} (${p.verifier})` : p.class,
        ),
        verifiers: producers.flatMap((p) => (p.verifier ? [p.verifier] : [])),
        read:
          read.length > 0
            ? `read from ${read.join(" or ")}`
            : "no producer here can meet it: it stays unmet",
        failure:
          local && !input.guard.active
            ? `${NO_GUARD} (${input.guard.detail})`
            : null,
      };
    },
  );
  const problems = [
    ...budgets.flatMap((b) =>
      b.failure ? [`Budget ${b.id} is across: environment: ${b.failure}.`] : [],
    ),
    ...evidence.flatMap((e) =>
      e.failure
        ? [
            `Gate ${e.gate} reads ${e.evidence} as runtime-observed: ${e.failure}.`,
          ]
        : [],
    ),
  ];
  return { budgets, evidence, problems };
}

/**
 * Whether the setup guard is on for this host: the hook apply writes always
 * carries the protect list, which refuses `nodrail` run by an agent and any
 * write to the run ledger, wherever it resolves. Claude Code runs it
 * unless a settings file turns hooks off; Codex and Copilot run it once the
 * person trusts the folder, which apply checks for Codex.
 */
function setupGuard(
  input: {
    root: string;
    home: string;
    env: Env;
    managed?: { claude?: string };
  },
  runtime: Runtime,
  files: readonly DesiredFile[],
) {
  if (!files.some((file) => file.path === PROTECT_LIST))
    return { active: false, detail: `apply writes no ${PROTECT_LIST}` };
  let ledger: string;
  try {
    ledger = input.env.NODRAIL_LEDGER
      ? ledgerDirectory(input.root, input.env)
      : nodrailDirectory(input.root, { ...input.env, HOME: input.home });
  } catch (error) {
    return {
      active: false,
      detail: `the run ledger can't be found to protect it: ${(error as Error).message}`,
    };
  }
  const on = {
    active: true,
    detail: `the hook carries the protect list and keeps agents out of the run ledger (${ledger})`,
  };
  if (runtime !== "claude-code") return on;
  const activation = claudeActivation({
    root: input.root,
    home: input.home,
    env: input.env,
    managed: input.managed?.claude,
  });
  return activation.state === "inactive"
    ? { active: false, detail: activation.detail }
    : on;
}

/** `accountablePlan` for the files a host's plan writes, with its guard. */
export function accountableHere(
  input: {
    root: string;
    home: string;
    env: Env;
    managed?: { claude?: string };
    decide?: "cloud" | "local";
  },
  runtime: Runtime,
  effective: string,
  files: readonly DesiredFile[],
) {
  return accountablePlan({
    effective,
    guard: setupGuard(input, runtime, files),
    connected: input.decide,
    cloud: files.some((file) => file.path === EVIDENCE_FILE),
  });
}
