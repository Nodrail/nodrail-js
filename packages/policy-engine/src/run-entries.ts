// Gates and budgets as written in rule files. Compiled in compile-runs.ts.
import { z } from "zod";
import { mode, refName, ruleFields } from "./file-fields.ts";

const { effect: _effect, ...matchFields } = ruleFields;
const holdEffect = z.enum(["deny", "require_approval"]);

const requirementEntry = z
  .strictObject({
    /** A receipt requirement names an agent and its verdicts. */
    agent: z.string().optional(),
    verdict: z
      .union([z.string(), z.array(z.string()).min(1).max(20)])
      .optional(),
    since: z
      .union([
        z.string(),
        z.array(z.string()).max(50),
        z.strictObject({ list: refName }),
      ])
      .optional(),
    // Engine version 4: checked against the agent's declared receipt contract.
    where: z.record(z.string(), z.unknown()).optional(),
    authority: z.string().optional(),
    subject: z.string().optional(),
    // Engine version 5: a requirement on evidence (S05), instead of an agent.
    evidence: z.string().optional(),
  })
  .refine(
    (entry) =>
      entry.evidence === undefined
        ? entry.agent !== undefined && entry.verdict !== undefined
        : entry.agent === undefined &&
          entry.verdict === undefined &&
          entry.since === undefined,
    {
      message:
        "A requirement names an agent and its verdict, or an evidence with its authority",
    },
  );

/**
 * Engine version 4: the declared contracts gates and receipts read, as
 * `nodrail.yaml` declares them (`shapes`, `receipts`) and the Agents that
 * pick a receipt. Checked in full by the contracts compiler. Only what this
 * engine enforces is accepted: any other contract key is refused.
 */
export const contractsItem = z.strictObject({
  contracts: z.strictObject({
    shapes: z.record(z.string(), z.unknown()).optional(),
    receipts: z.record(z.string(), z.unknown()).optional(),
    // Engine version 5: evidence a gate requirement can read (S05).
    evidence: z.record(z.string(), z.unknown()).optional(),
    // A receipt, a brief (S02) or both; the compiler checks each.
    agents: z
      .record(
        z.string(),
        z.strictObject({
          receipt: z.string().optional(),
          brief: z.unknown().optional(),
        }),
      )
      .optional(),
    // S03: each operation's input. A result (S04) is read where the call
    // is mediated, never by this hook, so `output` is refused here.
    connections: z
      .record(
        z.string(),
        z.strictObject({
          operations: z.record(
            z.string(),
            z.strictObject({ input: z.string() }),
          ),
        }),
      )
      .optional(),
  }),
});
export type ContractsEntry = z.infer<typeof contractsItem>["contracts"];
export type RequirementEntry = z.infer<typeof requirementEntry>;

const gateFields = {
  ...matchFields,
  requires: z.array(requirementEntry).min(1).max(20).optional(),
  otherwise: holdEffect.optional(),
};
export type GateFields = {
  [K in keyof typeof gateFields]?: z.infer<(typeof gateFields)[K]>;
};

export const gateItem = z.strictObject({
  gate: z.string().min(1).max(200),
  ...gateFields,
  override: z
    .partialRecord(
      z.enum(Object.keys(gateFields) as [string, ...string[]]),
      mode,
    )
    .optional(),
});

const budgetFields = {
  id: z.string().optional(),
  title: z.string().max(120).optional(),
  desc: z.string().max(500).optional(),
  step_agent: z.string().nullable().optional(),
  per: z.enum(["step", "run", "day"]).optional(),
  tool_calls: z.number().optional(),
  tokens: z.number().optional(),
  usd: z.number().optional(),
  // Engine version 5 (C03): numeric budgets.
  count: z.strictObject({ tool: z.string(), operation: z.string() }).optional(),
  sum: z
    .strictObject({ tool: z.string(), operation: z.string(), path: z.string() })
    .optional(),
  unit: z.string().optional(),
  limit: z.number().optional(),
  timezone: z.string().optional(),
  across: z.enum(["run", "environment"]).optional(),
  /** `tokens` the host measured, rather than what agents reported. */
  source: z.literal("measured").optional(),
  warn_at: z.number().nullable().optional(),
  otherwise: holdEffect.optional(),
  enabled: z.boolean().optional(),
};
export type BudgetFields = {
  [K in keyof typeof budgetFields]?: z.infer<(typeof budgetFields)[K]>;
};

export const budgetItem = z.strictObject({
  budget: z.string().min(1).max(200),
  ...budgetFields,
  override: z
    .partialRecord(
      z.enum(Object.keys(budgetFields) as [string, ...string[]]),
      z.literal("replace"),
    )
    .optional(),
});
