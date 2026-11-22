// Compiling gates and budgets. A gate is compiled by the rule compiler, so it
// matches exactly as a rule with the same fields would; then its requirements
// are added. Reading the files is in rules-file.ts and run-entries.ts.
import {
  Collector,
  type CompiledRule,
  type Located,
  type RuleFields,
  type State,
} from "./rules-file.ts";
import type { BudgetFields, RequirementEntry } from "./run-entries.ts";
import type { ContractNeeds } from "./compile-contracts.ts";
import { isTimeZone } from "./budget-windows.ts";
import { ACCOUNTABLE_ENGINE_LEVEL } from "./shapes/limits.ts";
import { agentName } from "./names.ts";
import { sourceOf, type BudgetMeasure } from "./policies.ts";
import { pick, type Path, type Place, type Where } from "./positions.ts";
import { otherwiseProblem } from "./removed-syntax.ts";

type Used = { lists: Set<string>; macros: Set<string> };
export type Compiling = {
  state: State;
  used: Used;
  collector: Collector;
  /** Engine version 4: what requirements read from declared contracts. */
  contracts?: ContractNeeds | null;
};

/** A compiled entry, and the entry it came from to report problems at. */
export type Compiled = {
  output: Record<string, unknown>;
  compiled: CompiledRule;
  entry: Place & { locate: Where };
};

/** What the rule compiler lends: checking a rule's shape and compiling it. */
export type RuleCompiler = {
  problem: (
    name: string,
    rule: Located<RuleFields>,
  ) => { message: string; paths: Path[] } | null;
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

/** Where a field of one requirement is, by the gate and the index. */
type RequirementPlace = (field: Path) => Place;

function since(
  value: RequirementEntry["since"],
  { state, used, collector }: Compiling,
  at: RequirementPlace,
) {
  if (value === undefined) return [];
  if (typeof value === "string" || Array.isArray(value)) {
    // `since: builders` names an agent called builders, which never works, so
    // the gate would quietly accept any earlier pass. Say what was meant.
    const names = Array.isArray(value) ? value : [value];
    names.forEach((name, index) => {
      if (state.lists.has(name))
        collector.error(
          at(Array.isArray(value) ? ["since", index] : ["since"]),
          `"${name}" is a list. Write since: { list: ${name} } to mean its agents.`,
        );
    });
    return many(value, agentName);
  }
  const list = state.lists.get(value.list);
  used.lists.add(value.list);
  if (!list) {
    collector.error(at(["since", "list"]), `Unknown list "${value.list}".`);
    return [];
  }
  return list.items.map((item) => agentName(String(item)));
}

function requirements(
  gate: Located<object>,
  entries: RequirementEntry[],
  compiling: Compiling,
  added: object[] = [],
) {
  // Evidence requirements (engine version 5) are compiled with the contracts.
  return entries.flatMap((entry, index) =>
    entry.evidence !== undefined || !entry.agent || !entry.verdict
      ? []
      : [
          {
            ...added[index],
            agent: agentName(entry.agent),
            verdicts: many(entry.verdict),
            since: since(entry.since, compiling, (field) =>
              pick(gate, [
                ["requires", index, ...field],
                ["requires", index],
              ]),
            ),
          },
        ],
  );
}

/** Gates as the evaluator's gates, one per resource or list item, like rules. */
export function compileGates(compiling: Compiling, rules: RuleCompiler) {
  const results: Compiled[] = [];
  for (const [name, gate] of compiling.state.gates) {
    const { requires, otherwise, ...match } = gate;
    if (gate.enabled === false) {
      // Off, but what it names is still in use.
      requirements(gate, requires ?? [], {
        ...compiling,
        collector: new Collector(),
      });
      continue;
    }
    if (!requires) {
      compiling.collector.error(gate, `Gate "${name}" needs requires.`);
      continue;
    }
    const removed = otherwiseProblem(`Gate "${name}"`, otherwise);
    if (removed) {
      compiling.collector.error(pick(gate, [["otherwise"]]), removed);
      continue;
    }
    const asRule = { ...match, effect: "deny" };
    const problem = rules.problem(name, asRule);
    if (problem) {
      compiling.collector.error(
        pick(gate, problem.paths),
        problem.message.replace(/^Rule/, "Gate"),
      );
      continue;
    }
    const added = contractFields(name, gate, compiling);
    const needs = requirements(gate, requires ?? [], compiling, added.needs);
    for (const item of rules.compile(name, asRule, compiling))
      results.push({
        ...item,
        output: { ...item.output, requires: needs, ...added.fields },
      });
  }
  return results;
}

/** What contracts add to a gate: its requirements' contracts, `where`, evidence. */
function contractFields(name: string, gate: object, compiling: Compiling) {
  const where = compiling.contracts?.where.get(gate);
  const evidence = compiling.contracts?.evidenceNeeds.get(name) ?? [];
  return {
    needs: compiling.contracts?.needs.get(name),
    fields: {
      ...(where ? { where } : {}),
      ...(evidence.length ? { evidence } : {}),
    },
  };
}

const metrics = ["tool_calls", "tokens", "usd"] as const;

/** Fields only a numeric budget (engine version 5) has. */
export const NUMERIC_FIELDS = [
  "count",
  "sum",
  "unit",
  "limit",
  "timezone",
  "across",
  "source",
] as const;

/** Whether a budget entry is a numeric budget (engine version 5). */
export const isNumeric = (budget: BudgetFields) =>
  NUMERIC_FIELDS.some((field) => budget[field] !== undefined) ||
  budget.per === "day";

const TOOL = /^[a-z0-9_-]{1,64}$/;
const OPERATION = /^[a-z0-9_.-]{1,128}$/;

/** What a numeric budget counts, or why it can't be read. */
function measureOf(budget: BudgetFields): BudgetMeasure | string {
  const kinds = [
    budget.count ? "count" : null,
    budget.sum ? "sum" : null,
    budget.tokens !== undefined ? "tokens" : null,
  ].filter(Boolean);
  if (budget.tool_calls !== undefined || budget.usd !== undefined)
    return "tool_calls and usd are agent-reported budgets; a numeric budget counts with count, sum or tokens (source: measured).";
  if (kinds.length !== 1)
    return "A numeric budget counts one thing: count, sum or tokens with source: measured.";
  if (budget.tokens !== undefined) {
    if (budget.source !== "measured")
      return "tokens without source: measured is an agent-reported budget; drop the numeric fields or add source: measured.";
    return { kind: "tokens" };
  }
  if (budget.source !== undefined)
    return "source: measured goes with tokens; count and sum say their own source.";
  const target = (budget.count ?? budget.sum)!;
  if (!TOOL.test(target.tool) || !OPERATION.test(target.operation))
    return "Name the tool and operation as rules do (lowercase letters, digits, _ and -).";
  if (budget.count) return { kind: "count", ...budget.count };
  const path = budget.sum!.path;
  if (!/^(?:input|result)(?:\.[a-z][a-z0-9_]{0,62}){1,4}$/.test(path))
    return "sum reads input.<path> (known before the call) or result.<path> (measured after it).";
  return { kind: "sum", ...budget.sum!, path };
}

/** The limit of a numeric budget, or why it isn't one. */
function limitOf(budget: BudgetFields, measure: BudgetMeasure) {
  const limit = measure.kind === "tokens" ? budget.tokens : budget.limit;
  if (measure.kind === "tokens" && budget.limit !== undefined)
    return "A measured tokens budget's limit is its tokens value; drop limit.";
  if (limit === undefined) return "A numeric budget needs a limit.";
  if (!Number.isSafeInteger(limit) || limit <= 0)
    return "A numeric budget's limit is a whole number above 0, in its unit's minor units.";
  return limit;
}

function unitOf(budget: BudgetFields, measure: BudgetMeasure) {
  const fixed = { count: "calls", tokens: "tokens" } as const;
  if (measure.kind !== "sum") {
    if (budget.unit !== undefined && budget.unit !== fixed[measure.kind])
      return `A ${measure.kind} budget is in ${fixed[measure.kind]}.`;
    return { unit: fixed[measure.kind] };
  }
  if (budget.unit === undefined)
    return "A sum budget names its unit, the same as the property it sums.";
  if (!/^[a-z][a-z0-9_]{0,31}$/.test(budget.unit))
    return "A unit is lowercase, such as usd_cents.";
  return { unit: budget.unit };
}

/** Window and reach: `day` needs its IANA timezone, and only it has one. */
function windowOf(budget: BudgetFields) {
  const per = budget.per!;
  if (per === "day") {
    if (!budget.timezone)
      return "per: day needs timezone, an IANA name such as Europe/Madrid.";
    if (!isTimeZone(budget.timezone))
      return `${budget.timezone} isn't an IANA timezone.`;
    if (!budget.across)
      return "per: day needs across: run (this run's calls today) or environment (every run's, enforced online).";
  } else if (budget.timezone !== undefined)
    return "Only per: day has a timezone.";
  const across = budget.across ?? "run";
  if (per === "step" && across === "environment")
    return "A step is one machine's; share a run or a day instead.";
  return { per, timezone: budget.timezone ?? null, across };
}

function compileNumeric(
  name: string,
  budget: Located<BudgetFields>,
  compiling: Compiling,
  slug: (text: string) => string,
): Compiled | null {
  const { collector } = compiling;
  const fail = (message: string) => {
    collector.error(budget, `Budget "${name}": ${message}`);
    return null;
  };
  if (
    (compiling.state.levels?.get(budget.file) ?? 0) < ACCOUNTABLE_ENGINE_LEVEL
  )
    return fail(
      `numeric budgets need required_engine_version: ${ACCOUNTABLE_ENGINE_LEVEL} in this file, so older engines refuse it.`,
    );
  const measure = measureOf(budget);
  if (typeof measure === "string") return fail(measure);
  const limit = limitOf(budget, measure);
  if (typeof limit === "string") return fail(limit);
  const unit = unitOf(budget, measure);
  if (typeof unit === "string") return fail(unit);
  const window = windowOf(budget);
  if (typeof window === "string") return fail(window);
  if (budget.warn_at !== undefined && budget.warn_at !== null)
    return fail("warn_at is for agent-reported budgets.");
  const source = sourceOf(measure);
  return compiledBudget(name, budget, slug, {
    measure,
    unit: unit.unit,
    source,
    label: source === "admission" ? "enforced-allowance" : "measured-usage",
    limit,
    ...window,
    effect: "deny",
  });
}

/** A budget as the document carries it, and where it came from. */
function compiledBudget(
  name: string,
  budget: Located<BudgetFields>,
  slug: (text: string) => string,
  fields: Record<string, unknown>,
): Compiled {
  const id = budget.id ?? slug(name).slice(0, 63);
  const shown = budget.title ?? name;
  return {
    output: {
      id,
      name: shown,
      agent: budget.step_agent ? agentName(budget.step_agent) : null,
      ...fields,
    },
    compiled: {
      id,
      name: shown,
      description: budget.desc ?? null,
      tags: [],
      source: { file: budget.file, line: budget.line },
    },
    entry: budget,
  };
}

function compileBudget(
  name: string,
  budget: Located<BudgetFields>,
  compiling: Compiling,
  slug: (text: string) => string,
): Compiled | null {
  const { collector } = compiling;
  const set = metrics.filter((metric) => budget[metric] !== undefined);
  if (!budget.per) {
    collector.error(budget, `Budget "${name}" needs per.`);
    return null;
  }
  const removed = otherwiseProblem(`Budget "${name}"`, budget.otherwise);
  if (removed) {
    collector.error(pick(budget, [["otherwise"]]), removed);
    return null;
  }
  if (isNumeric(budget)) return compileNumeric(name, budget, compiling, slug);
  if (set.length !== 1) {
    // With two or more, at the second; with none, at the budget.
    collector.error(
      pick(
        budget,
        set.slice(1).map((metric) => [metric]),
        "key",
      ),
      `Budget "${name}" sets one of tool_calls, tokens or usd; use one budget per limit.`,
    );
    return null;
  }
  const [metric] = set as [(typeof metrics)[number]];
  return compiledBudget(name, budget, slug, {
    per: budget.per,
    metric,
    limit: budget[metric],
    warnAt: budget.warn_at ?? null,
    effect: "deny",
  });
}

export function compileBudgets(compiling: Compiling, rules: RuleCompiler) {
  return [...compiling.state.budgets].flatMap(([name, budget]) =>
    budget.enabled === false
      ? []
      : (compileBudget(name, budget, compiling, rules.slug) ?? []),
  );
}
