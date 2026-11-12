import { z } from "zod";
import { isPlainJson } from "./json.ts";

export const effects = ["deny", "require_approval", "allow"] as const;
export type Effect = (typeof effects)[number];

const scalar = z.union([z.string().max(256), z.number(), z.boolean()]);

export const conditionOperators = [
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
  "contains",
] as const;

export const condition = z
  .object({
    field: z.string().regex(/^[A-Za-z0-9_.]{1,64}$/),
    op: z.enum(conditionOperators),
    value: z.union([scalar, z.array(scalar).min(1).max(50)]),
  })
  .strict()
  .refine((item) => (item.op === "in") === Array.isArray(item.value));
export type Condition = z.infer<typeof condition>;

export const resourceScope = z
  .object({
    kind: z.string().trim().min(1).max(64),
    match: z.enum(["any", "exact", "prefix"]),
    value: z.string().max(4096).optional(),
  })
  .strict()
  .overwrite((scope) => {
    if (scope.value === undefined) return scope;
    // The space ending "git log " is what stops it matching "git logger".
    const keepsEnd = scope.kind === "command" && scope.match === "prefix";
    const value = keepsEnd ? scope.value.trimStart() : scope.value.trim();
    return { ...scope, value };
  })
  .refine(
    ({ value }) =>
      value === undefined || (value.trim().length > 0 && value.length <= 512),
    { path: ["value"] },
  )
  .refine((scope) => (scope.match === "any") === (scope.value === undefined));
export type ResourceScope = z.infer<typeof resourceScope>;

const name = z.string().trim().min(1).max(120);

const key = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/);

export const operationPattern = "[a-z0-9_\\-]+\\.[a-z0-9_.\\-]+";

export const ruleInput = z
  .object({
    name,
    effect: z.enum(effects),
    agentKey: key.nullable(),
    installationName: key.nullable(),
    toolKey: z.string().regex(/^[a-z0-9_-]{1,64}$/),
    operationKey: z.string().regex(/^[a-z0-9_.-]{1,128}$/),
    resource: resourceScope,
    conditions: z.array(condition).max(20),
    expiresAt: z.iso.datetime({ offset: true }).nullable(),
  })
  .strict()
  .refine((rule) => !rule.installationName || rule.agentKey, {
    path: ["installationName"],
  });
export type RuleInput = z.infer<typeof ruleInput>;

export const POLICY_DOCUMENT_VERSION = 1 as const;
/** A document with gates or budgets. Engines before it reject it, never ignore it. */
export const RUN_DOCUMENT_VERSION = 2 as const;

const policyRule = ruleInput.extend({
  id: key,
});
export type PolicyRule = z.infer<typeof policyRule>;

const policyRules = z
  .array(policyRule)
  .max(500)
  .superRefine((rules, context) => {
    const seen = new Set<string>();
    rules.forEach((rule, index) => {
      if (seen.has(rule.id))
        context.addIssue({
          code: "custom",
          path: [index, "id"],
          message: "Rule ids must be unique within a policy document",
        });
      seen.add(rule.id);
    });
  });

/** An agent's name inside a run, and the words it reports. */
export const runName = key;
export const verdict = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/);

export const requirement = z
  .object({
    agent: runName,
    verdicts: z.array(verdict).min(1).max(20),
    since: z.array(runName).max(50),
  })
  .strict();
export type Requirement = z.infer<typeof requirement>;

/** Matches like a rule; its effect applies only while a requirement is unmet. */
const policyGate = policyRule.safeExtend({
  effect: z.enum(["deny", "require_approval"]),
  requires: z.array(requirement).min(1).max(20),
});
export type PolicyGate = z.infer<typeof policyGate>;

export const budgetMetrics = ["tool_calls", "tokens", "usd"] as const;
export type BudgetMetric = (typeof budgetMetrics)[number];

export const policyBudget = z
  .object({
    id: key,
    name,
    agent: runName.nullable(),
    per: z.enum(["step", "run"]),
    metric: z.enum(budgetMetrics),
    limit: z.number().positive().max(1e12),
    warnAt: z.number().positive().nullable(),
    effect: z.enum(["deny", "require_approval"]),
  })
  .strict()
  .refine((budget) => budget.warnAt === null || budget.warnAt < budget.limit, {
    path: ["warnAt"],
    message: "warn_at must be below the limit",
  })
  .refine(
    (budget) =>
      budget.metric !== "tool_calls" || Number.isInteger(budget.limit),
    {
      path: ["limit"],
      message: "A tool call limit is a whole number",
    },
  )
  // Tokens and dollars are known only when a step finishes, so a step can't be held to them.
  .refine((budget) => budget.per === "run" || budget.metric === "tool_calls", {
    path: ["per"],
    message:
      "Only tool_calls can be limited per step; limit tokens and usd per run",
  });
export type PolicyBudget = z.infer<typeof policyBudget>;

const documentV1 = z
  .object({ version: z.literal(POLICY_DOCUMENT_VERSION), rules: policyRules })
  .strict();

const documentV2 = z
  .object({
    version: z.literal(RUN_DOCUMENT_VERSION),
    rules: policyRules,
    gates: z.array(policyGate).max(200),
    budgets: z.array(policyBudget).max(50),
  })
  .strict()
  .superRefine((document, context) => {
    // A decision names the entry that won, so a gate can't share a rule's id.
    const seen = new Set(document.rules.map((rule) => rule.id));
    for (const field of ["gates", "budgets"] as const)
      document[field].forEach((item, index) => {
        if (seen.has(item.id))
          context.addIssue({
            code: "custom",
            path: [field, index, "id"],
            message:
              "Rule, gate and budget ids must be unique within a policy document",
          });
        seen.add(item.id);
      });
  });

export const policyDocument = z.discriminatedUnion("version", [
  documentV1,
  documentV2,
]);
export type PolicyDocument = z.infer<typeof policyDocument>;

export const simulationRequest = z
  .object({
    version: z.literal(POLICY_DOCUMENT_VERSION),
    descriptor: z
      .object({
        agentId: z.string().min(1),
        installationId: z.string().min(1),
        toolKey: z.string().min(1),
        operationKey: z.string().min(1),
        resourceKind: z.string().min(1),
        resourceId: z.string().min(1),
        params: z.record(z.string(), z.unknown()).refine(isPlainJson),
      })
      .strict(),
    rules: policyRules,
    now: z.iso.datetime({ offset: true }),
  })
  .strict();

export type SimulationRequest = z.infer<typeof simulationRequest>;
