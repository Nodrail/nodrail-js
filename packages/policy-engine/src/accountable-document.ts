// What a version 4 policy document adds (engine level 5): evidence
// requirements on gates (S05 on C01) and numeric budgets (C03), with the
// label each budget's source gives it. policies.ts puts them in the document.
import { z } from "zod";
import {
  compiledCondition,
  contractDigestText,
  resolvedShape,
} from "./contract-document.ts";
import { isTimeZone } from "./budget-windows.ts";
import type { PolicyBudget } from "./policies.ts";
import { contractDigest } from "./shapes/digest.ts";
import { UNIT } from "./shapes/limits.ts";

const key = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/);
const name = z.string().trim().min(1).max(120);
const runName = key;

/**
 * A gate requirement on evidence (S05 on C01, version 4). Met by the latest
 * event of that evidence about the current revision, from a producer of at
 * least `authority`, validated with the pinned contract and meeting every
 * `where`. `subject` is always `revision`: an old result never opens a gate
 * for new work.
 */
export const evidenceNeed = z
  .object({
    evidence: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
    contract: contractDigestText,
    where: z.array(compiledCondition).max(20),
    authority: z.enum([
      "agent-reported",
      "runtime-observed",
      "externally-verified",
    ]),
    subject: z.literal("revision"),
  })
  .strict();
export type EvidenceNeed = z.infer<typeof evidenceNeed>;

/** Who may produce an evidence, as its declaration lists them. */
const evidenceProducer = z
  .object({
    class: z.enum(["runtime-observed", "externally-verified"]),
    verifier: z.string().min(1).max(63).nullable(),
  })
  .strict()
  .refine(
    (p) => (p.class === "externally-verified") === (p.verifier !== null),
    { message: "externally-verified names its verifier, and only it does" },
  );

/** One evidence's contract, pinned like a receipt's. */
export const evidenceContract = z
  .object({
    name: z.string().regex(/^evidence:[a-z][a-z0-9-]{0,62}$/),
    contract: contractDigestText,
    shape: resolvedShape,
    producers: z.array(evidenceProducer).min(1).max(10),
    subject: z.enum(["revision", "none"]),
  })
  .strict()
  .refine((value) => contractDigest("shape", value.shape) === value.contract, {
    path: ["contract"],
    message: "The contract digest isn't the shape's",
  });
export type EvidenceContract = z.infer<typeof evidenceContract>;

/**
 * What a numeric budget counts (C03). `count`: calls of one operation the
 * hook let go ahead. `sum`: one integer path of an operation's input (known
 * before the call, so reserved) or result (measured after it). `tokens`:
 * subagent tokens the host measured.
 */
const toolKey = z.string().regex(/^[a-z0-9_-]{1,64}$/);
const operationKey = z.string().regex(/^[a-z0-9_.-]{1,128}$/);
export const budgetMeasure = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("count"),
      tool: toolKey,
      operation: operationKey,
    })
    .strict(),
  z
    .object({
      kind: z.literal("sum"),
      tool: toolKey,
      operation: operationKey,
      path: z
        .string()
        .regex(
          /^(?:input|result)(?:\.[a-z][a-z0-9_]{0,62}){1,4}$/,
          "input.<path> or result.<path>",
        ),
    })
    .strict(),
  z.object({ kind: z.literal("tokens") }).strict(),
]);
export type BudgetMeasure = z.infer<typeof budgetMeasure>;

/**
 * Who the numbers come from, which decides what the budget can promise.
 * `admission`: known before the call and reserved, a hard allowance.
 * `measured`: known only after; it stops further work, never caps a call.
 */
export const budgetSources = ["admission", "measured"] as const;
export type BudgetSource = (typeof budgetSources)[number];

/** Labels derived from the source, never configured (UI and plan copy). */
export const BUDGET_LABELS = {
  "enforced-allowance": "Enforced allowance",
  "measured-usage": "Measured usage · stops further work",
  "agent-reported-usage": "Agent-reported usage · advisory limit",
} as const;
export type BudgetLabel = keyof typeof BUDGET_LABELS;

/** The source a measure implies: an input is known before the call. */
export function sourceOf(measure: BudgetMeasure): BudgetSource {
  if (measure.kind === "count") return "admission";
  if (measure.kind === "sum" && measure.path.startsWith("input."))
    return "admission";
  return "measured";
}

/**
 * A numeric budget (version 4): a whole-number limit in one unit, per step,
 * run or calendar day in an IANA time zone, held by this run's ledger or by
 * the shared online authority (`across: environment`).
 */
export const numericBudget = z
  .object({
    id: key,
    name,
    agent: runName.nullable(),
    measure: budgetMeasure,
    unit: z.string().regex(UNIT),
    source: z.enum(budgetSources),
    label: z.enum(["enforced-allowance", "measured-usage"]),
    limit: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    per: z.enum(["step", "run", "day"]),
    timezone: z.string().min(1).max(64).nullable(),
    across: z.enum(["run", "environment"]),
    effect: z.enum(["deny", "require_approval"]),
  })
  .strict()
  .refine((b) => (b.per === "day") === (b.timezone !== null), {
    path: ["timezone"],
    message: "A day window, and only one, names its IANA timezone",
  })
  .refine((b) => b.timezone === null || isTimeZone(b.timezone), {
    path: ["timezone"],
    message: "Not an IANA timezone",
  })
  .refine((b) => !(b.per === "step" && b.across === "environment"), {
    path: ["across"],
    message: "A step is one machine's; share a run or day instead",
  })
  .refine((b) => b.source === sourceOf(b.measure), {
    path: ["source"],
    message: "The source follows from what the budget counts",
  })
  .refine(
    (b) =>
      b.label ===
      (b.source === "admission" ? "enforced-allowance" : "measured-usage"),
    { path: ["label"], message: "The label follows from the source" },
  )
  .refine(
    (b) =>
      (b.measure.kind !== "count" || b.unit === "calls") &&
      (b.measure.kind !== "tokens" || b.unit === "tokens"),
    { path: ["unit"], message: "count is in calls, tokens in tokens" },
  );
export type NumericBudget = z.infer<typeof numericBudget>;

/** The label a budget shows, whichever document it is in (R283 for legacy usage). */
export function budgetLabel(budget: PolicyBudget | NumericBudget): BudgetLabel {
  if ("measure" in budget) return budget.label;
  return budget.metric === "tool_calls"
    ? "enforced-allowance"
    : "agent-reported-usage";
}

type Pinned = { contract: string | null };
/** What the pin checks read of a version 3 or 4 document. */
type PinnedDocument = {
  inputs?: Record<string, { name: string }>;
  receipts: Record<string, Pinned>;
  gates: { requires: (Pinned & { agent: string })[] }[];
};
type EvidenceDocument = Omit<PinnedDocument, "gates"> & {
  evidence: Record<string, { name: string; contract: string }>;
  gates: (PinnedDocument["gates"][number] & {
    evidence?: (Pinned & { evidence: string })[];
  })[];
};

const issue = (
  context: z.RefinementCtx,
  path: (string | number)[],
  message: string,
) => context.addIssue({ code: "custom", path, message });

/**
 * Each input is bound as `input:<key>`, and each receipt requirement pins
 * the receipt contract its agent is read with (versions 3 and 4).
 */
export function checkReceiptPins(
  document: PinnedDocument,
  context: z.RefinementCtx,
) {
  for (const [key, input] of Object.entries(document.inputs ?? {}))
    if (input.name !== `input:${key}`)
      issue(
        context,
        ["inputs", key, "name"],
        `The input of ${key} must be bound as input:${key}`,
      );
  document.gates.forEach((gate, index) =>
    gate.requires.forEach((need, at) => {
      const pinned = document.receipts[need.agent]?.contract ?? null;
      if (need.contract !== pinned)
        issue(
          context,
          ["gates", index, "requires", at, "contract"],
          `The requirement must pin ${need.agent}'s receipt contract`,
        );
    }),
  );
}

/**
 * Version 4 also: each evidence is bound as `evidence:<key>`, every gate
 * requires something, and each evidence requirement pins its contract.
 */
export function checkPins(
  document: EvidenceDocument,
  context: z.RefinementCtx,
) {
  checkReceiptPins(document, context);
  for (const [key, evidence] of Object.entries(document.evidence))
    if (evidence.name !== `evidence:${key}`)
      issue(
        context,
        ["evidence", key, "name"],
        `The evidence ${key} must be bound as evidence:${key}`,
      );
  document.gates.forEach((gate, index) => {
    const evidence = gate.evidence ?? [];
    if (!gate.requires.length && !evidence.length)
      issue(context, ["gates", index, "requires"], "A gate requires something");
    evidence.forEach((need, at) => {
      if (document.evidence[need.evidence]?.contract !== need.contract)
        issue(
          context,
          ["gates", index, "evidence", at, "contract"],
          `The requirement must pin ${need.evidence}'s contract`,
        );
    });
  });
}
