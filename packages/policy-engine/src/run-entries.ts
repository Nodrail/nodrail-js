// Gates and budgets as written in rule files. Compiled in compile-runs.ts.
import { z } from "zod";
import { mode, refName, ruleFields } from "./file-fields.ts";

const { effect: _effect, ...matchFields } = ruleFields;
const holdEffect = z.enum(["deny", "require_approval"]);

const requirementEntry = z.strictObject({
  agent: z.string(),
  verdict: z.union([z.string(), z.array(z.string()).min(1).max(20)]),
  since: z
    .union([
      z.string(),
      z.array(z.string()).max(50),
      z.strictObject({ list: refName }),
    ])
    .optional(),
});
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
  per: z.enum(["step", "run"]).optional(),
  tool_calls: z.number().optional(),
  tokens: z.number().optional(),
  usd: z.number().optional(),
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
