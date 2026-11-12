// Compiling: turning rules read from files into the evaluator's document.
// Reading and checking the files themselves is in rules-file.ts.
import type { z } from "zod";
import { classifyCommand } from "./commands.ts";
import { reportSchemaIssues } from "./compile-issues.ts";
import {
  compileBudgets,
  compileGates,
  type RuleCompiler,
} from "./compile-runs.ts";
import { policyDocument, type Condition } from "./policies.ts";
import { pick, type Path, type Place } from "./positions.ts";
import { legacySubagentRuleProblem } from "./upgrades.ts";
import {
  Collector,
  readFile,
  type CompileResult,
  type CompiledRule,
  type ConditionEntry,
  type fileCommand,
  type fileResource,
  type PolicySource,
  type State,
} from "./rules-file.ts";

/** Stable across runs and needs no Node APIs, so this works in a browser too. */
function shortHash(text: string) {
  let hash = 0x811c9dc5;
  for (const char of text) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function slug(text: string) {
  const plain = text
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
  return plain || "rule";
}

const MAX_CONDITIONS = 20;

type Used = { lists: Set<string>; macros: Set<string> };
type RuleEntry = State["rules"] extends Map<string, infer R> ? R : never;
/** What compiling one set of files shares: what was read, used and reported. */
type Compiling = { state: State; used: Used; collector: Collector };
/** How deep inside macros a condition sits, and how many are left to spend. */
type Nesting = { stack: string[]; budget: { left: number } };

/** Where the condition at an index of the rule is; inside a macro, its use. */
type ConditionPlace = (index: number) => Place;

function expandConditions(
  entries: ConditionEntry[],
  compiling: Compiling,
  place: ConditionPlace,
  nesting: Nesting = { stack: [], budget: { left: MAX_CONDITIONS } },
): unknown[] {
  const { state, used, collector } = compiling;
  const { stack, budget } = nesting;
  return entries.flatMap((entry, index): unknown[] => {
    const at = place(index);
    // Stops here rather than after nested macros have filled memory.
    if (budget.left <= 0) {
      if (budget.left === 0)
        collector.error(
          at,
          `Rules can have ${MAX_CONDITIONS} conditions at most.`,
        );
      budget.left = -1;
      return [];
    }
    if ("macro" in entry) {
      const macro = state.macros.get(entry.macro);
      used.macros.add(entry.macro);
      if (!macro) {
        collector.error(at, `Unknown macro "${entry.macro}".`);
        return [];
      }
      if (stack.includes(entry.macro)) {
        collector.error(at, `Macro "${entry.macro}" refers to itself.`);
        return [];
      }
      return expandConditions(macro.condition, compiling, () => at, {
        stack: [...stack, entry.macro],
        budget,
      });
    }
    budget.left -= 1;
    if ("list" in entry) {
      const list = state.lists.get(entry.list);
      used.lists.add(entry.list);
      if (!list) {
        collector.error(at, `Unknown list "${entry.list}".`);
        return [];
      }
      if (entry.op === "contains") {
        if (!list.items.length) {
          collector.error(
            at,
            `List "${entry.list}" is empty, so this rule would do nothing.`,
          );
          return [];
        }
        // Any of the items: one compiled rule per item, see anyOfVariants.
        return [{ field: entry.field, op: "contains", anyOf: list.items }];
      }
      return [{ field: entry.field, op: "in", value: list.items }];
    }
    return [entry];
  });
}

const required = ["tool", "operation", "resource", "effect"] as const;

type Expansion = {
  id: string;
  label: string;
  tool: unknown;
  operation: unknown;
  resource: unknown;
};

/** The name a rule is shown with, and the id its compiled rules start from. */
type Naming = { name: string; base: string };

function resourceExpansions(
  rule: RuleEntry,
  { name, base }: Naming,
  { state, used, collector }: Compiling,
): Expansion[] | null {
  const resource = rule.resource as z.infer<typeof fileResource>;
  const shared = { tool: rule.tool, operation: rule.operation };
  if (!("list" in resource))
    return [{ ...shared, id: base, label: name, resource }];
  const list = state.lists.get(resource.list);
  used.lists.add(resource.list);
  const at = pick(rule, [["resource", "list"]]);
  if (!list) {
    collector.error(at, `Unknown list "${resource.list}".`);
    return null;
  }
  if (!list.items.length) {
    collector.error(
      at,
      `List "${resource.list}" is empty, so this rule would do nothing.`,
    );
    return null;
  }
  return list.items.map((item) => {
    const value = String(item);
    return {
      ...shared,
      id: `${base.slice(0, 54)}-${shortHash(value)}`,
      label: `${name} (${value})`.slice(0, 120),
      resource: {
        kind: resource.kind,
        match: resource.match ?? "exact",
        value,
      },
    };
  });
}

/**
 * A prefix means whole words, so "git log" covers "git log -1" but not
 * "git logger". That takes two rules in the evaluator's literal terms.
 */
function commandExpansions(
  rule: RuleEntry,
  { name, base }: Naming,
  { state, used, collector }: Compiling,
): Expansion[] | null {
  const command = rule.command as z.infer<typeof fileCommand>;
  const fromList = typeof command === "object" && "list" in command;
  const at = pick(rule, [
    ["command", "list"],
    ["command", "prefix"],
    ["command"],
  ]);
  let values: unknown[];
  if (fromList) {
    const list = state.lists.get(command.list);
    used.lists.add(command.list);
    if (!list) {
      collector.error(at, `Unknown list "${command.list}".`);
      return null;
    }
    if (!list.items.length) {
      collector.error(
        at,
        `List "${command.list}" is empty, so this rule would do nothing.`,
      );
      return null;
    }
    values = list.items;
  } else values = [typeof command === "string" ? command : command.prefix];
  const prefix =
    typeof command === "object" &&
    ("prefix" in command || command.match === "prefix");

  const shared = { tool: "shell", operation: "command.run" };
  const expansions: Expansion[] = [];
  for (const raw of values) {
    const { operation, text } = classifyCommand(String(raw));
    if (operation !== "command.run") {
      collector.error(
        at,
        `"${String(raw)}" uses shell syntax or runs another program, so it can only be judged as a whole. Use tool: shell, operation: command.compound.`,
      );
      return null;
    }
    const exact = fromList ? `${base.slice(0, 54)}-${shortHash(text)}` : base;
    const label = fromList ? `${name} (${text})` : name;
    expansions.push({
      ...shared,
      id: exact,
      label: label.slice(0, 120),
      resource: { kind: "command", match: "exact", value: text },
    });
    if (prefix)
      expansions.push({
        ...shared,
        id: fromList
          ? `${base.slice(0, 54)}-${shortHash(`${text} *`)}`
          : `${base.slice(0, 58)}-args`,
        label: `${label} with arguments`.slice(0, 120),
        resource: { kind: "command", match: "prefix", value: `${text} ` },
      });
  }
  return expansions;
}

type AnyOf = { field: string; op: "contains"; anyOf: unknown[] };
const isAnyOf = (condition: unknown): condition is AnyOf =>
  typeof condition === "object" && condition !== null && "anyOf" in condition;

/**
 * There is no `or` in the evaluator, so "contains any of a list" becomes one
 * rule per item. One such condition per rule keeps the count predictable.
 */
function anyOfVariants(
  conditions: unknown[],
  name: string,
  at: Place,
  collector: Collector,
): { conditions: Condition[]; item: string | null }[] | null {
  const lists = conditions.filter(isAnyOf);
  const rest = conditions.filter(
    (condition) => !isAnyOf(condition),
  ) as Condition[];
  if (lists.length > 1) {
    collector.error(
      at,
      `Rule "${name}" can use "contains" with a list only once.`,
    );
    return null;
  }
  const [anyOf] = lists;
  if (!anyOf) return [{ conditions: rest, item: null }];
  return anyOf.anyOf.map((item) => ({
    item: String(item),
    conditions: [
      ...rest,
      { field: anyOf.field, op: "contains", value: item } as Condition,
    ],
  }));
}

/** A switched-off rule still counts as using what it names. */
function markUsed(rule: RuleEntry, { state, used }: Compiling) {
  // Problems here belong to a rule that is off, so they aren't reported.
  expandConditions(
    rule.condition ?? [],
    { state, used, collector: new Collector() },
    () => rule,
  );
  if (rule.resource && "list" in rule.resource)
    used.lists.add(rule.resource.list);
  if (typeof rule.command === "object" && "list" in rule.command)
    used.lists.add(rule.command.list);
}

/** Why a rule can't compile at all, before looking inside it, and where. */
function ruleProblem(
  name: string,
  rule: RuleEntry,
): { message: string; paths: Path[] } | null {
  const needed = rule.command === undefined ? required : (["effect"] as const);
  const missing = needed.filter((field) => rule[field] === undefined);
  if (missing.length)
    return {
      message: `Rule "${name}" needs ${missing.join(", ")}.`,
      paths: [],
    };
  if (
    rule.command !== undefined &&
    (rule.tool ?? rule.operation ?? rule.resource) !== undefined
  )
    return {
      message: `Rule "${name}" sets command, so it cannot also set tool, operation or resource.`,
      paths: [["command"]],
    };
  const legacy = legacySubagentRuleProblem({
    toolKey: rule.tool ?? "",
    operationKey: rule.operation ?? "",
    resourceKind: rule.resource?.kind ?? "",
  });
  return legacy
    ? { message: `Rule "${name}": ${legacy}`, paths: [["resource"]] }
    : null;
}

/** One rule as the evaluator's rules, one per resource or list item. */
function compileRule(name: string, rule: RuleEntry, compiling: Compiling) {
  const variants = anyOfVariants(
    expandConditions(rule.condition ?? [], compiling, (index) =>
      pick(rule, [["condition", index]]),
    ),
    name,
    pick(rule, [["condition"]]),
    compiling.collector,
  );
  if (!variants) return [];
  const base = rule.id ?? slug(name).slice(0, 63);
  const shownName = rule.title ?? name;
  const naming = { name: shownName, base };
  const expansions =
    rule.command === undefined
      ? resourceExpansions(rule, naming, compiling)
      : commandExpansions(rule, naming, compiling);
  if (!expansions) return [];
  return expansions.flatMap((plain) =>
    variants.map(({ conditions, item }) => {
      const expansion =
        item === null
          ? plain
          : {
              ...plain,
              id: `${plain.id.slice(0, 54)}-${shortHash(item)}`,
              label: `${plain.label} (${item})`.slice(0, 120),
            };
      return {
        output: {
          id: expansion.id,
          name: expansion.label,
          effect: rule.effect,
          agentKey: rule.agent ?? null,
          installationName: rule.installation ?? null,
          toolKey: expansion.tool,
          operationKey: expansion.operation,
          resource: expansion.resource,
          conditions,
          expiresAt: rule.expires ?? null,
        },
        compiled: {
          id: expansion.id,
          name: expansion.label,
          description: rule.desc ?? null,
          tags: rule.tags ?? [],
          source: { file: rule.file, line: rule.line },
        } satisfies CompiledRule,
        entry: rule,
      };
    }),
  );
}

function warnUnused({ state, used, collector }: Compiling) {
  for (const [name, list] of state.lists)
    if (!used.lists.has(name))
      collector.warn(list, `List "${name}" is not used.`);
  for (const [name, macro] of state.macros)
    if (!used.macros.has(name))
      collector.warn(macro, `Macro "${name}" is not used.`);
}

const ruleCompiler: RuleCompiler = {
  problem: (name, rule) => ruleProblem(name, rule as RuleEntry),
  compile: (name, rule, compiling) =>
    compileRule(name, rule as RuleEntry, compiling),
  slug,
};

/**
 * Turns rule files into one policy document for the one evaluator. Later files
 * layer over earlier ones; every problem is reported at its own file and line.
 */
export function compilePolicies(sources: PolicySource[]): CompileResult {
  const collector = new Collector();
  const state: State = {
    lists: new Map(),
    macros: new Map(),
    rules: new Map(),
    gates: new Map(),
    budgets: new Map(),
  };
  for (const source of sources) readFile(source, state, collector);
  const compiling: Compiling = {
    state,
    used: { lists: new Set<string>(), macros: new Set<string>() },
    collector,
  };

  const results: ReturnType<typeof compileRule> = [];
  for (const [name, rule] of state.rules) {
    if (rule.enabled === false) {
      markUsed(rule, compiling);
      continue;
    }
    const problem = ruleProblem(name, rule);
    if (problem) collector.error(pick(rule, problem.paths), problem.message);
    else results.push(...compileRule(name, rule, compiling));
  }
  const gates = compileGates(compiling, ruleCompiler);
  const budgets = compileBudgets(compiling, ruleCompiler);
  warnUnused(compiling);

  const compiled = results.map((result) => result.compiled);
  const outputs = (items: { output: unknown }[]) =>
    items.map((item) => item.output);
  // Only a document that needs them is version 2, so every other stays readable by older engines.
  const parsed = policyDocument.safeParse(
    gates.length || budgets.length
      ? {
          version: 2,
          rules: outputs(results),
          gates: outputs(gates),
          budgets: outputs(budgets),
        }
      : { version: 1, rules: outputs(results) },
  );
  if (!parsed.success)
    reportSchemaIssues(
      parsed.error.issues,
      { rules: results, gates, budgets },
      sources[0]?.name ?? "rules",
      collector,
    );

  const { issues, warnings } = collector;
  if (issues.length || !parsed.success) return { ok: false, issues, warnings };
  return { ok: true, document: parsed.data, rules: compiled, warnings };
}
