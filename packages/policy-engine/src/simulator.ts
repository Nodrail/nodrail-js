import {
  policyDocument,
  simulationRequest,
  type PolicyDocument,
} from "./policies.ts";
import {
  evaluate,
  type Descriptor,
  type EvaluatedRule,
  type Evaluation,
} from "./evaluator.ts";
import { isPlainJson } from "./json.ts";

export type SimulationInput = {
  document: unknown;
  descriptor: Descriptor;
  now: Date;
};

export type SimulationResult = Evaluation & {
  reason: "explicit_rule" | "no_matching_rule";
  explanation: string;
};

function toEvaluated(document: PolicyDocument): EvaluatedRule[] {
  return document.rules.map((rule) => ({
    logicalRuleId: rule.id,
    agentId: rule.agentKey,
    installationId: rule.installationName,
    toolKey: rule.toolKey,
    operationKey: rule.operationKey,
    effect: rule.effect,
    resource: rule.resource,
    conditions: rule.conditions,
    expiresAt: rule.expiresAt ? new Date(rule.expiresAt) : null,
  }));
}

export function simulate({
  document,
  descriptor,
  now,
}: SimulationInput): SimulationResult {
  if (!Number.isFinite(now.getTime()))
    throw new Error("Simulation clock must be a valid date");
  const parsed = policyDocument.parse(document);
  const request = simulationRequest.parse({
    version: parsed.version,
    descriptor,
    rules: parsed.rules,
    now: now.toISOString(),
  });
  if (!isPlainJson(request.descriptor.params))
    throw new Error("Simulation parameters must be finite plain JSON");
  const effectiveNow = new Date(request.now);
  if (!Number.isFinite(effectiveNow.getTime()))
    throw new Error("Simulation clock must be a valid date");
  const result = evaluate(
    request.descriptor,
    toEvaluated(request),
    effectiveNow,
  );
  if (result.outcome === "none") {
    return {
      ...result,
      reason: "no_matching_rule",
      explanation: "No rule matched this descriptor; the default is blocked.",
    };
  }
  return {
    ...result,
    reason: "explicit_rule",
    explanation: `Matched ${result.matchedRuleId} with effect ${result.outcome}.`,
  };
}
