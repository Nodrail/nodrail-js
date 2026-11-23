import {
  explainLimit,
  holds,
  limitState,
  type BudgetAuthority,
  type LimitState,
} from "./budget-ledger.ts";
import {
  describeEvidence,
  evidenceShortfall,
  type EvidenceReader,
} from "./run-evidence.ts";
import {
  POLICY_DOCUMENT_VERSION,
  declaredGateId,
  evidenceOf,
  hasContracts,
  limitsOf,
  policyDocument,
  type EvidenceNeed,
  simulationRequest,
  type PolicyGate,
  type PolicyRule,
  type Requirement,
} from "./policies.ts";
import {
  evaluate,
  type ContractValues,
  type Descriptor,
  type EvaluatedRule,
  type Evaluation,
} from "./evaluator.ts";
import { isPlainJson } from "./json.ts";
import {
  budgetState,
  explainBudget,
  explainGate,
  runContext,
  unmetRequirements,
  type BudgetState,
  type RunContext,
  type Subject,
} from "./runs.ts";

export type SimulationInput = {
  document: unknown;
  descriptor: Descriptor;
  now: Date;
  /**
   * The run this action belongs to. Without one, every gate is unmet and every
   * budget that covers the action holds it.
   */
  run?: RunContext | null;
  /**
   * The revision the work is at now, as the runtime observes it: read only
   * when a requirement with `subject: revision` needs it. Without one, such
   * a requirement is unmet.
   */
  subject?: Subject | null;
  /**
   * The call's values validated against a declared contract, which typed
   * `where` conditions read. Without them, an allow with `where` never
   * matches, and a deny with `where` does.
   */
  values?: ContractValues | null;
  /**
   * Reads evidence for requirements on it (version 4). Without it, every
   * evidence requirement is unmet.
   */
  evidence?: EvidenceReader | null;
  /**
   * Who counts numeric budgets (version 4): `local` is this run's ledger.
   * Without one, a numeric budget that covers the call holds it.
   */
  budgets?: BudgetAuthority;
};

/** An evidence requirement a gate still needs, and why, in declared words. */
export type EvidenceShortfall = {
  need: EvidenceNeed;
  index: number;
  reason: string;
};

export type GateResult = {
  id: string;
  name: string;
  /** Whether the gate matched this action at all. */
  applies: boolean;
  missing: Requirement[];
  /** Version 4: evidence requirements still unmet. */
  evidence?: EvidenceShortfall[];
};

export type SimulationResult = Evaluation & {
  reason: "explicit_rule" | "gate" | "budget" | "no_matching_rule";
  explanation: string;
  gates: GateResult[];
  budgets: BudgetState[];
  /** Version 4: each numeric budget that covers the call, and where it stands. */
  limits?: LimitState[];
  warnings: string[];
};

function toEvaluated(rule: PolicyRule | PolicyGate): EvaluatedRule {
  return {
    logicalRuleId: rule.id,
    agentId: rule.agentKey,
    installationId: rule.installationName,
    toolKey: rule.toolKey,
    operationKey: rule.operationKey,
    effect: rule.effect,
    resource: rule.resource,
    conditions: rule.conditions,
    expiresAt: rule.expiresAt ? new Date(rule.expiresAt) : null,
    ...("where" in rule && rule.where ? { where: rule.where } : {}),
  };
}

/**
 * Lower wins. No matching rule is blocked by default, so it is stronger than
 * an allow.
 */
const strength = { deny: 0, none: 1, allow: 2 } as const;

function checkInput({ document, descriptor, now, run }: SimulationInput) {
  if (!Number.isFinite(now.getTime()))
    throw new Error("Simulation clock must be a valid date");
  const parsed = policyDocument.parse(document);
  const request = simulationRequest.parse({
    version: POLICY_DOCUMENT_VERSION,
    descriptor,
    rules: parsed.rules,
    now: now.toISOString(),
  });
  if (!isPlainJson(request.descriptor.params))
    throw new Error("Simulation parameters must be finite plain JSON");
  const effectiveNow = new Date(request.now);
  if (!Number.isFinite(effectiveNow.getTime()))
    throw new Error("Simulation clock must be a valid date");
  return {
    document: parsed,
    descriptor: request.descriptor,
    now: effectiveNow,
    run: run ? runContext.parse(run) : null,
  };
}

/** Reads the revision once, however many requirements ask; a failure is unknown. */
function memo(subject: Subject | null | undefined): Subject | null {
  if (!subject) return null;
  let read: { value: string | null } | null = null;
  return () => {
    if (!read)
      try {
        read = { value: subject() };
      } catch {
        read = { value: null };
      }
    return read.value;
  };
}

/** Each gate, whether it covers this action and what it still needs. */
type Checked = ReturnType<typeof checkInput> & {
  subject: Subject | null;
  values: ContractValues | null;
  evidence: EvidenceReader | null;
};

/** The evidence requirements of a gate the run hasn't met. */
function unmetEvidence(gate: PolicyGate, checked: Checked, applies: boolean) {
  return evidenceOf(gate).flatMap((need, index) => {
    const reason = evidenceShortfall(
      need,
      { gate: gate.id, index },
      {
        // A gate that doesn't cover the action never costs a look at the work.
        subject: applies ? (checked.subject?.() ?? null) : null,
        evidence: checked.evidence,
      },
    );
    return reason === null ? [] : [{ need, index, reason }];
  });
}

/**
 * Each gate, whether it covers this action and what it still needs. The
 * revision is read only for a gate that covers the action, so a gate
 * elsewhere never costs a look at the work; there it counts as unknown.
 */
function judgeGates(checked: Checked) {
  const { document, descriptor, run, now, subject, values } = checked;
  if (document.version === 1) return [];
  return document.gates.map((gate: PolicyGate) => {
    const covers = evaluate(descriptor, [toEvaluated(gate)], now, values);
    const applies = covers.outcome !== "none";
    const evidence =
      document.version === 4 ? unmetEvidence(gate, checked, applies) : [];
    return {
      gate,
      result: {
        id: gate.id,
        name: gate.name,
        applies,
        missing: unmetRequirements(gate, run, applies ? subject : null),
        ...(document.version === 4 ? { evidence } : {}),
      } satisfies GateResult,
    };
  });
}

const unmet = (result: GateResult) =>
  result.missing.length > 0 || (result.evidence?.length ?? 0) > 0;

/** Why a gate holds: its receipt requirements, then its evidence ones. */
function gateWords(
  gate: ReturnType<typeof judgeGates>[number],
  checked: Checked,
) {
  const evidence = gate.result.evidence ?? [];
  const receipts = gate.result.missing.length
    ? hasContracts(checked.document)
      ? explainGate(
          gate.gate,
          gate.result.missing,
          checked.run,
          checked.subject,
        )
      : explainGate(gate.gate, gate.result.missing)
    : null;
  if (!evidence.length) return receipts ?? explainGate(gate.gate, []);
  const said = evidence
    .map(({ need, reason }) => `${describeEvidence(need)} (${reason})`)
    .join("; ");
  return receipts
    ? `${receipts.replace(/\.$/, "")}; ${said}.`
    : `Gate ${declaredGateId(gate.gate)} needs ${said}.`;
}

type Judged = {
  gates: ReturnType<typeof judgeGates>;
  budgets: BudgetState[];
  limits: LimitState[];
};

function explain(
  winner: Evaluation,
  { gates, budgets, limits }: Judged,
  checked: Checked,
): Pick<SimulationResult, "reason" | "explanation"> {
  if (winner.outcome === "none")
    return {
      reason: "no_matching_rule",
      explanation: "No rule matched this descriptor; the default is blocked.",
    };
  const gate = gates.find(({ gate }) => gate.id === winner.matchedRuleId);
  if (gate)
    return {
      reason: "gate",
      // With contracts, the gate also says why each agent's last step fell short.
      explanation: gateWords(gate, checked),
    };
  const budget = budgets.find(({ id }) => id === winner.matchedRuleId);
  if (budget) return { reason: "budget", explanation: explainBudget(budget) };
  const limit = limits.find(({ id }) => id === winner.matchedRuleId);
  if (limit) return { reason: "budget", explanation: explainLimit(limit) };
  return {
    reason: "explicit_rule",
    explanation: `Matched ${winner.matchedRuleId} with effect ${winner.outcome}.`,
  };
}

/**
 * The rules decide alone first. A gate that still needs something, and a
 * budget that is used up or has no run to count in, can then only make that
 * stronger: deny, then blocked by default, then allow. Neither
 * ever allows anything, nor weakens what the rules decided.
 */
export function simulate(input: SimulationInput): SimulationResult {
  const checked: Checked = {
    ...checkInput(input),
    subject: memo(input.subject),
    values: input.values ?? null,
    evidence: input.evidence ?? null,
  };
  const { document, descriptor, now, run, values } = checked;
  const gates = judgeGates(checked);
  const ruled = evaluate(
    descriptor,
    document.rules.map(toEvaluated),
    now,
    values,
  );
  const gated = evaluate(
    descriptor,
    gates
      .filter(({ result }) => unmet(result))
      .map(({ gate }) => toEvaluated(gate)),
    now,
    values,
  );
  const budgets =
    document.version === 1
      ? []
      : document.budgets.flatMap((budget) => budgetState(budget, run) ?? []);
  const limits = limitsOf(document).flatMap(
    (budget) =>
      limitState(budget, {
        run,
        call: {
          tool: descriptor.toolKey,
          operation: descriptor.operationKey,
          values,
        },
        now,
        authority: input.budgets ?? null,
      }) ?? [],
  );
  const candidates: Evaluation[] = [
    ruled,
    ...(gated.outcome === "none" ? [] : [gated]),
    ...budgets
      .filter((budget) => budget.state === "over" || budget.state === "no_run")
      .map((budget) => ({ outcome: budget.effect, matchedRuleId: budget.id })),
    ...limits
      .filter(holds)
      .map((limit) => ({ outcome: limit.effect, matchedRuleId: limit.id })),
  ];
  const winner = candidates.reduce((best, next) =>
    strength[next.outcome] < strength[best.outcome] ? next : best,
  );
  return {
    ...winner,
    ...explain(winner, { gates, budgets, limits }, checked),
    gates: gates.map(({ result }) => result),
    budgets,
    ...(document.version === 4 ? { limits } : {}),
    warnings: budgets
      .filter((budget) => budget.state === "warn")
      .map(explainBudget),
  };
}
