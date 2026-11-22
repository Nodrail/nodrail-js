import type { Condition, Effect, ResourceScope } from "./policies.ts";
import type { CompiledCondition } from "./shapes/types.ts";
import { matchWhere } from "./shapes/validate.ts";

/**
 * The validated values a call's typed `where` reads (engine version 4):
 * `input`, the call's arguments that passed the operation's declared input;
 * `brief`, the started agent's brief that passed its contract.
 */
export type ContractValues = { input?: unknown; brief?: unknown };

export type Descriptor = {
  agentId: string;
  installationId: string;
  toolKey: string;
  operationKey: string;
  resourceKind: string;
  resourceId: string;
  params: Record<string, unknown>;
};

export type EvaluatedRule = {
  logicalRuleId: string;
  agentId: string | null;
  installationId: string | null;
  toolKey: string;
  operationKey: string;
  effect: Effect;
  resource: ResourceScope;
  conditions: Condition[];
  expiresAt: Date | null;
  /** Typed conditions on declared values (C02); only with contracts. */
  where?: CompiledCondition[];
};

export type Evaluation = {
  outcome: Effect | "none";
  matchedRuleId: string | null;
};

export function readField(
  params: Record<string, unknown>,
  path: string,
): unknown {
  let current: unknown = params;
  for (const part of path.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    if (!Object.hasOwn(current, part)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function compare(actual: unknown, { op, value }: Condition): boolean {
  switch (op) {
    case "eq":
      return actual === value;
    case "neq":
      return actual !== value;
    case "in":
      return Array.isArray(value) && value.some((item) => item === actual);
    case "contains":
      return Array.isArray(actual) && actual.some((item) => item === value);
    default: {
      if (typeof actual !== "number" || typeof value !== "number") return false;
      if (op === "gt") return actual > value;
      if (op === "gte") return actual >= value;
      if (op === "lt") return actual < value;
      return actual <= value;
    }
  }
}

export function resourceMatches(scope: ResourceScope, descriptor: Descriptor) {
  if (scope.kind !== descriptor.resourceKind) return false;
  if (scope.match === "any") return true;
  if (scope.match === "exact") return descriptor.resourceId === scope.value;
  return descriptor.resourceId.startsWith(scope.value ?? "\u0000");
}

/**
 * Whether a parameter is the kind of value this condition can judge. An agent
 * controls its parameters, so "5000" must not slip past a rule on amount > 1000.
 */
function comparable(actual: unknown, { op, value }: Condition) {
  if (op === "contains") return Array.isArray(actual);
  if (op === "in")
    return (
      Array.isArray(value) &&
      value.some((item) => typeof item === typeof actual)
    );
  return typeof actual === typeof value && !Array.isArray(actual);
}

/**
 * A parameter that is missing or the wrong kind never helps an allow rule, and
 * deny rules still apply.
 */
export function conditionsMatch(rule: EvaluatedRule, descriptor: Descriptor) {
  return rule.conditions.every((condition) => {
    const actual = readField(descriptor.params, condition.field);
    if (actual === undefined || !comparable(actual, condition))
      return rule.effect !== "allow";
    return compare(actual, condition);
  });
}

/**
 * A rule's typed `where` against the validated values: every condition must
 * hold, and a missing value satisfies none. When the call carries no
 * validated value for a root the rule reads (nothing checked it against a
 * contract), an allow never matches and a deny still does, as
 * with conditions on parameters.
 */
function whereMatches(rule: EvaluatedRule, values: ContractValues | null) {
  if (!rule.where?.length) return true;
  const roots = new Set(rule.where.map((condition) => condition.path[0]));
  const checked = [...roots].every(
    (root) =>
      values !== null &&
      (root === "input" || root === "brief") &&
      values[root] !== undefined,
  );
  if (!checked) return rule.effect !== "allow";
  return matchWhere(rule.where, values);
}

export function matches(
  rule: EvaluatedRule,
  descriptor: Descriptor,
  now: Date,
  values: ContractValues | null = null,
) {
  if (rule.expiresAt && rule.expiresAt <= now) return false;
  if (rule.agentId && rule.agentId !== descriptor.agentId) return false;
  if (rule.installationId && rule.installationId !== descriptor.installationId)
    return false;
  return (
    rule.toolKey === descriptor.toolKey &&
    rule.operationKey === descriptor.operationKey &&
    resourceMatches(rule.resource, descriptor) &&
    conditionsMatch(rule, descriptor) &&
    whereMatches(rule, values)
  );
}

/** Fixed precedence, independent of rule order: deny, then allow. */
function evaluateOne(
  descriptor: Descriptor,
  rules: EvaluatedRule[],
  now: Date,
  values: ContractValues | null,
): Evaluation {
  const matched = rules
    .filter((rule) => matches(rule, descriptor, now, values))
    .sort((a, b) => a.logicalRuleId.localeCompare(b.logicalRuleId));
  for (const effect of ["deny", "allow"] as const) {
    const winner = matched.find((rule) => rule.effect === effect);
    if (winner) return { outcome: effect, matchedRuleId: winner.logicalRuleId };
  }
  return { outcome: "none", matchedRuleId: null };
}

function chainOf({ toolKey, operationKey, params }: Descriptor) {
  if (toolKey !== "shell" || operationKey !== "command.compound") return null;
  const parts = Object.hasOwn(params, "parts") ? params.parts : null;
  return Array.isArray(parts) &&
    parts.length > 0 &&
    parts.every((part) => typeof part === "string")
    ? (parts as string[])
    : null;
}

/**
 * A chain of simple commands is as safe as its worst part. A rule on the whole
 * line can vouch for parts nothing covers, but never overrule a part's deny.
 */
export function evaluate(
  descriptor: Descriptor,
  rules: EvaluatedRule[],
  now: Date,
  values: ContractValues | null = null,
): Evaluation {
  const whole = evaluateOne(descriptor, rules, now, values);
  const parts = chainOf(descriptor);
  if (!parts || whole.outcome === "deny") return whole;
  const each = parts.map((part) =>
    evaluateOne(
      {
        ...descriptor,
        operationKey: "command.run",
        resourceId: part,
        params: { ...descriptor.params, command: part },
      },
      rules,
      now,
      values,
    ),
  );
  const first = (outcome: Evaluation["outcome"]) =>
    each.find((item) => item.outcome === outcome);
  const denied = first("deny");
  if (denied) return denied;
  if (whole.outcome === "allow") return whole;
  return first("none") ?? each[0] ?? whole;
}
