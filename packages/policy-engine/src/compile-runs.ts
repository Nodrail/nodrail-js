// Compiling gates and budgets. A gate is compiled by the rule compiler, so it
// matches exactly as a rule with the same fields would; then its requirements
// are added. Reading the files is in rules-file.ts and run-entries.ts.
import {
  Collector,
  type CompiledRule,
  type RuleFields,
  type State,
} from "./rules-file.ts";
import type { BudgetFields, RequirementEntry } from "./run-entries.ts";
import { agentName } from "./names.ts";

type Place = { file: string; line: number; column: number };
type Located<T> = T & Place;
type Used = { lists: Set<string>; macros: Set<string> };
export type Compiling = { state: State; used: Used; collector: Collector };

type Compiled = { output: Record<string, unknown>; compiled: CompiledRule };

/** What the rule compiler lends: checking a rule's shape and compiling it. */
export type RuleCompiler = {
  problem: (name: string, rule: Located<RuleFields>) => string | null;
  compile: (
    name: string,
    rule: Located<RuleFields>,
    compiling: Compiling,
  ) => Compiled[];
  slug: (text: string) => string;
};

const lower = (text: string) => text.trim().toLowerCase();
const many = (value: string | string[], name = lower) =>
  (Array.isArray(value) ? value : [value]).map(name);

function since(
  value: RequirementEntry["since"],
  { state, used, collector }: Compiling,
  at: Place,
) {
  if (value === undefined) return [];
  if (typeof value === "string" || Array.isArray(value)) {
    // `since: builders` names an agent called builders, which never works, so
    // the gate would quietly accept any earlier pass. Say what was meant.
    for (const name of Array.isArray(value) ? value : [value])
      if (state.lists.has(name))
        collector.error(
          at,
          `"${name}" is a list. Write since: { list: ${name} } to mean its agents.`,
        );
    return many(value, agentName);
  }
  const list = state.lists.get(value.list);
  used.lists.add(value.list);
  if (!list) {
    collector.error(at, `Unknown list "${value.list}".`);
    return [];
  }
  return list.items.map((item) => agentName(String(item)));
}

function requirements(
  entries: RequirementEntry[],
  compiling: Compiling,
  at: Place,
) {
  return entries.map((entry) => ({
    agent: agentName(entry.agent),
    verdicts: many(entry.verdict),
    since: since(entry.since, compiling, at),
  }));
}

/** Gates as the evaluator's gates, one per resource or list item, like rules. */
export function compileGates(compiling: Compiling, rules: RuleCompiler) {
  const results: Compiled[] = [];
  for (const [name, gate] of compiling.state.gates) {
    const at = { file: gate.file, line: gate.line, column: gate.column };
    const { requires, otherwise, ...match } = gate;
    if (gate.enabled === false) {
      // Off, but what it names is still in use.
      requirements(
        requires ?? [],
        { ...compiling, collector: new Collector() },
        at,
      );
      continue;
    }
    const missing = [
      ...(requires ? [] : ["requires"]),
      ...(otherwise ? [] : ["otherwise"]),
    ];
    if (missing.length) {
      compiling.collector.error(
        at,
        `Gate "${name}" needs ${missing.join(", ")}.`,
      );
      continue;
    }
    const asRule = { ...match, effect: otherwise };
    const problem = rules.problem(name, asRule);
    if (problem) {
      compiling.collector.error(at, problem.replace(/^Rule/, "Gate"));
      continue;
    }
    const needs = requirements(requires ?? [], compiling, at);
    for (const item of rules.compile(name, asRule, compiling))
      results.push({ ...item, output: { ...item.output, requires: needs } });
  }
  return results;
}

const metrics = ["tool_calls", "tokens", "usd"] as const;

function compileBudget(
  name: string,
  budget: Located<BudgetFields>,
  { collector }: Compiling,
  slug: (text: string) => string,
): Compiled | null {
  const at = { file: budget.file, line: budget.line, column: budget.column };
  const set = metrics.filter((metric) => budget[metric] !== undefined);
  const missing = [
    ...(budget.per ? [] : ["per"]),
    ...(budget.otherwise ? [] : ["otherwise"]),
  ];
  if (missing.length) {
    collector.error(at, `Budget "${name}" needs ${missing.join(", ")}.`);
    return null;
  }
  if (set.length !== 1) {
    collector.error(
      at,
      `Budget "${name}" sets one of tool_calls, tokens or usd; use one budget per limit.`,
    );
    return null;
  }
  const [metric] = set as [(typeof metrics)[number]];
  const id = budget.id ?? slug(name).slice(0, 63);
  const shown = budget.title ?? name;
  return {
    output: {
      id,
      name: shown,
      agent: budget.step_agent ? agentName(budget.step_agent) : null,
      per: budget.per,
      metric,
      limit: budget[metric],
      warnAt: budget.warn_at ?? null,
      effect: budget.otherwise,
    },
    compiled: {
      id,
      name: shown,
      description: budget.desc ?? null,
      tags: [],
      source: { file: budget.file, line: budget.line },
    },
  };
}

export function compileBudgets(compiling: Compiling, rules: RuleCompiler) {
  return [...compiling.state.budgets].flatMap(([name, budget]) =>
    budget.enabled === false
      ? []
      : (compileBudget(name, budget, compiling, rules.slug) ?? []),
  );
}
