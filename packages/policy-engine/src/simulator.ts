import {
  POLICY_DOCUMENT_VERSION,
  policyDocument,
  simulationRequest,
  type PolicyDocument,
  type PolicyGate,
  type PolicyRule,
  type Requirement,
} from "./policies.ts";
import {
  evaluate,
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
};

export type GateResult = {
  id: string;
  name: string;
  /** Whether the gate matched this action at all. */
  applies: boolean;
  missing: Requirement[];
};

export type SimulationResult = Evaluation & {
  reason: "explicit_rule" | "gate" | "budget" | "no_matching_rule";
  explanation: string;
  gates: GateResult[];
  budgets: BudgetState[];
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
  };
}

/**
 * Lower wins. No matching rule is blocked by default, so it is stronger than a
 * review: a gate or budget asking for one never turns "blocked" into "ask".
 */
const strength = { deny: 0, none: 1, require_approval: 2, allow: 3 } as const;

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

/** Each gate, whether it covers this action and what it still needs. */
function judgeGates(
  document: PolicyDocument,
  descriptor: Descriptor,
  run: RunContext | null,
  now: Date,
) {
  if (document.version !== 2) return [];
  return document.gates.map((gate) => {
    const covers = evaluate(descriptor, [toEvaluated(gate)], now);
    return {
      gate,
      result: {
        id: gate.id,
        name: gate.name,
        applies: covers.outcome !== "none",
        missing: unmetRequirements(gate, run),
      } satisfies GateResult,
    };
  });
}

function explain(
  winner: Evaluation,
  gates: ReturnType<typeof judgeGates>,
  budgets: BudgetState[],
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
      explanation: explainGate(gate.gate, gate.result.missing),
    };
  const budget = budgets.find(({ id }) => id === winner.matchedRuleId);
  if (budget) return { reason: "budget", explanation: explainBudget(budget) };
  return {
    reason: "explicit_rule",
    explanation: `Matched ${winner.matchedRuleId} with effect ${winner.outcome}.`,
  };
}

/**
 * The rules decide alone first. A gate that still needs something, and a
 * budget that is used up or has no run to count in, can then only make that
 * stronger: deny, then blocked by default, then review, then allow. Neither
 * ever allows anything, nor weakens what the rules decided.
 */
export function simulate(input: SimulationInput): SimulationResult {
  const { document, descriptor, now, run } = checkInput(input);
  const gates = judgeGates(document, descriptor, run, now);
  const ruled = evaluate(descriptor, document.rules.map(toEvaluated), now);
  const gated = evaluate(
    descriptor,
    gates
      .filter(({ result }) => result.missing.length)
      .map(({ gate }) => toEvaluated(gate)),
    now,
  );
  const budgets =
    document.version === 2
      ? document.budgets.flatMap((budget) => budgetState(budget, run) ?? [])
      : [];
  const candidates: Evaluation[] = [
    ruled,
    ...(gated.outcome === "none" ? [] : [gated]),
    ...budgets
      .filter((budget) => budget.state === "over" || budget.state === "no_run")
      .map((budget) => ({ outcome: budget.effect, matchedRuleId: budget.id })),
  ];
  const winner = candidates.reduce((best, next) =>
    strength[next.outcome] < strength[best.outcome] ? next : best,
  );
  return {
    ...winner,
    ...explain(winner, gates, budgets),
    gates: gates.map(({ result }) => result),
    budgets,
    warnings: budgets
      .filter((budget) => budget.state === "warn")
      .map(explainBudget),
  };
}
