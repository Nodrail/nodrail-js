import { nonEmptyText, type ToolInput } from "./actions.ts";
import { covers } from "./budget-ledger.ts";
import { describedCall, type LocalHookOptions } from "./local-hook.ts";
import { agentName } from "./names.ts";
import type { NumericBudget } from "./policies.ts";
import { valueAt } from "./shapes/validate.ts";

const numberOf = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;

export const tokensOf = (event: Record<string, unknown>) =>
  numberOf(valueAt(event.tool_response, ["totalTokens"]));

export type OutcomeTool = Pick<LocalHookOptions, "connections" | "host">;

export function sharedLimitsForOutcome(
  event: Record<string, unknown>,
  limits: readonly NumericBudget[],
  tool: OutcomeTool,
) {
  if (!limits.some((budget) => budget.across === "environment")) return [];
  const name = nonEmptyText(event.tool_name);
  if (!name) return [];
  const args = event.tool_input as ToolInput | undefined;
  const action = describedCall(name, args ?? {}, event, tool);
  if (typeof action === "string") return [];
  const agent = event.agent_id
    ? agentName(nonEmptyText(event.agent_type) ?? "unnamed")
    : "main";
  return limits.filter(
    (budget) =>
      budget.across === "environment" &&
      covers(budget, { ...action, values: null }, agent),
  );
}

export type ReadingFields = { paths: string[]; tokens: boolean };

export function readingFields(limits: readonly NumericBudget[]): ReadingFields {
  return {
    paths: [
      ...new Set(
        limits.flatMap(({ measure, source }) =>
          source === "measured" && measure.kind === "sum" ? [measure.path] : [],
        ),
      ),
    ],
    tokens: limits.some(({ measure }) => measure.kind === "tokens"),
  };
}

export function readOutcomeFields(
  event: Record<string, unknown>,
  fields: ReadingFields,
) {
  const result =
    valueAt(event.tool_response, ["structuredContent"]) ?? event.tool_response;
  const measured = fields.paths
    .flatMap((path) => {
      const value = numberOf(valueAt(result, path.split(".").slice(1)));
      return value === null ? [] : [{ path, value }];
    })
    .slice(0, 20);
  const tokens = fields.tokens ? tokensOf(event) : null;
  return {
    ...(measured.length ? { measured } : {}),
    ...(tokens !== null ? { tokens } : {}),
  };
}

export function remoteReadings(
  event: Record<string, unknown>,
  limits: readonly NumericBudget[],
) {
  return readOutcomeFields(event, readingFields(limits));
}
