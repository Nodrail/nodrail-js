import { z } from "zod";
import { isPlainJson } from "./json.ts";
import {
  briefContract,
  compiledCondition,
  contractDigestText,
  inputContract,
  receiptContract,
  ruleCondition,
} from "./contract-document.ts";
import {
  ACCOUNTABLE_DOCUMENT_VERSION,
  CONTRACTS_DOCUMENT_VERSION,
} from "./shapes/limits.ts";
import {
  checkPins,
  checkReceiptPins,
  evidenceContract,
  evidenceNeed,
  numericBudget,
} from "./accountable-document.ts";

export * from "./accountable-document.ts";
export * from "./document-kinds.ts";

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
/**
 * A document with declared contracts (version 3): receipts read against
 * their contract, and gate requirements with `where`, authority and subject.
 * Engines before it reject it, never ignore it.
 */
export { CONTRACTS_DOCUMENT_VERSION };
/**
 * A document with evidence requirements or accountable budgets (version 4,
 * engine level 5). Engines and readers before it reject it, never ignore it.
 */
export { ACCOUNTABLE_DOCUMENT_VERSION };

const policyRule = ruleInput.extend({
  id: key,
});
export type PolicyRule = z.infer<typeof policyRule> & {
  /** Only in a document with contracts: see contractRule. */
  where?: z.infer<typeof ruleCondition>[];
};

const uniqueRuleIds = (rules: { id: string }[], context: z.RefinementCtx) => {
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
};
const policyRules = z.array(policyRule).max(500).superRefine(uniqueRuleIds);

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

/**
 * A requirement in a document with contracts. `contract` pins the receipt
 * contract a step's receipt must have been validated with; null for an agent
 * with no declared receipt, whose receipt is read as before. A receipt is
 * agent-reported, the only authority a receipt requirement can ask for.
 */
export const contractRequirement = requirement.safeExtend({
  contract: contractDigestText.nullable(),
  where: z.array(compiledCondition).max(20),
  authority: z.literal("agent-reported"),
  /** `revision`: the receipt must be about the revision the gate sees. */
  subject: z.literal("revision").nullable(),
});
export type ContractRequirement = z.infer<typeof contractRequirement>;
type PlainRequirement = z.infer<typeof requirement>;
/** A gate's requirement, in a document with contracts or without. */
export type Requirement = PlainRequirement &
  Partial<Omit<ContractRequirement, keyof PlainRequirement>>;

/** Matches like a rule; its effect applies only while a requirement is unmet. */
const policyGate = policyRule.safeExtend({
  effect: z.enum(["deny", "require_approval"]),
  requires: z.array(requirement).min(1).max(20),
});
/**
 * A rule's or gate's `where` in a document with contracts (C02): typed
 * conditions on the call's declared input or the started agent's brief.
 * Only present when the rule has one, so other rules read as before.
 */
const ruleWhere = z.array(ruleCondition).min(1).max(20).optional();
const contractRule = policyRule.safeExtend({ where: ruleWhere });
const contractRules = z.array(contractRule).max(500).superRefine(uniqueRuleIds);
const contractGate = policyGate.safeExtend({
  requires: z.array(contractRequirement).min(1).max(20),
  where: ruleWhere,
});
export type PolicyGate =
  | z.infer<typeof policyGate>
  | z.infer<typeof contractGate>
  | z.infer<typeof accountableGate>;

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

type Entries = {
  rules: { id: string }[];
  gates: { id: string }[];
  budgets: { id: string }[];
};

/** A decision names the entry that won, so a gate can't share a rule's id. */
function uniqueIds(document: Entries, context: z.RefinementCtx) {
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
}

const documentV2 = z
  .object({
    version: z.literal(RUN_DOCUMENT_VERSION),
    rules: policyRules,
    gates: z.array(policyGate).max(200),
    budgets: z.array(policyBudget).max(50),
  })
  .strict()
  .superRefine(uniqueIds);

/** What versions 3 and 4 declare: receipts always, briefs and inputs when declared. */
const declaredContracts = {
  /** Each agent with a declared receipt, by its run name. */
  receipts: z.record(runName, receiptContract),
  /** Each agent with a declared brief (S02), by its run name. Only when one is. */
  briefs: z.record(runName, briefContract).optional(),
  /** Each operation with a declared input (S03), by `<tool>.<operation>`. Only when one is. */
  inputs: z
    .record(
      z.string().regex(/^[a-z0-9_-]{1,64}\.[a-z0-9_-]{1,128}$/),
      inputContract,
    )
    .optional(),
};

const documentV3 = z
  .object({
    version: z.literal(CONTRACTS_DOCUMENT_VERSION),
    rules: contractRules,
    gates: z.array(contractGate).max(200),
    budgets: z.array(policyBudget).max(50),
    ...declaredContracts,
  })
  .strict()
  .superRefine(uniqueIds)
  .superRefine(checkReceiptPins);

/** In version 4 a gate may wait only for evidence, so `requires` may be empty. */
const accountableGate = policyGate.safeExtend({
  requires: z.array(contractRequirement).max(20),
  where: ruleWhere,
  evidence: z.array(evidenceNeed).max(20).optional(),
});

const documentV4 = z
  .object({
    version: z.literal(ACCOUNTABLE_DOCUMENT_VERSION),
    rules: contractRules,
    gates: z.array(accountableGate).max(200),
    budgets: z.array(policyBudget).max(50),
    /** Numeric budgets (C03), apart from the legacy ones above. */
    limits: z.array(numericBudget).max(50),
    ...declaredContracts,
    /** Each evidence a requirement reads, by name. */
    evidence: z.record(z.string(), evidenceContract),
  })
  .strict()
  .superRefine((document, context) =>
    uniqueIds(
      {
        ...document,
        budgets: [...document.budgets, ...document.limits],
      },
      context,
    ),
  )
  .superRefine(checkPins);

export const policyDocument = z.discriminatedUnion("version", [
  documentV1,
  documentV2,
  documentV3,
  documentV4,
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
    // The document's own rules, already checked by its version: only a
    // version 3 document's can carry `where`.
    rules: contractRules,
    now: z.iso.datetime({ offset: true }),
  })
  .strict();

export type SimulationRequest = z.infer<typeof simulationRequest>;
