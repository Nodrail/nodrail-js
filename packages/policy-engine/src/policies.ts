import { z } from "zod";
import { isPlainJson } from "./json";

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

export const policyDocument = z
  .object({
    version: z.literal(POLICY_DOCUMENT_VERSION),
    rules: policyRules,
  })
  .strict();
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
