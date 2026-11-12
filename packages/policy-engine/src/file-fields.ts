// The fields rule files are made of, shared by rules, gates and budgets.
import { z } from "zod";

export const scalar = z.union([z.string(), z.number(), z.boolean()]);
export const mode = z.enum(["append", "replace"]);
export const refName = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/);

export const conditionEntry = z.union([
  z.strictObject({ macro: refName }),
  z.strictObject({
    field: z.string(),
    op: z.enum(["in", "contains"]),
    list: refName,
  }),
  z.strictObject({ field: z.string(), op: z.string(), value: z.unknown() }),
]);
export type ConditionEntry = z.infer<typeof conditionEntry>;

export const versionItem = z.strictObject({
  required_engine_version: z.number().int().positive(),
});

export const listItem = z.strictObject({
  list: refName,
  items: z.array(scalar).max(500),
  override: z.strictObject({ items: mode }).optional(),
});

export const macroItem = z.strictObject({
  macro: refName,
  condition: z.array(conditionEntry).min(1).max(20),
  override: z.strictObject({ condition: mode }).optional(),
});

export const fileResource = z.union([
  z.strictObject({
    kind: z.string(),
    match: z.enum(["exact", "prefix"]).optional(),
    list: refName,
  }),
  z.strictObject({
    kind: z.string(),
    match: z.enum(["any", "exact", "prefix"]),
    value: z.string().optional(),
  }),
]);

export const fileCommand = z.union([
  z.string().min(1).max(512),
  z.strictObject({ prefix: z.string().min(1).max(512) }),
  z.strictObject({
    list: refName,
    match: z.enum(["exact", "prefix"]).optional(),
  }),
]);

export const ruleFields = {
  id: z.string().optional(),
  title: z.string().max(120).optional(),
  desc: z.string().max(500).optional(),
  tool: z.string().optional(),
  operation: z.string().optional(),
  resource: fileResource.optional(),
  command: fileCommand.optional(),
  condition: z.array(conditionEntry).max(20).optional(),
  effect: z.string().optional(),
  agent: z.string().nullable().optional(),
  installation: z.string().nullable().optional(),
  expires: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
  tags: z.array(z.string().max(64)).max(20).optional(),
};
export type RuleFields = {
  [K in keyof typeof ruleFields]?: z.infer<(typeof ruleFields)[K]>;
};
