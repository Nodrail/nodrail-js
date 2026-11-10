import {
  parseDocument,
  LineCounter,
  isMap,
  isSeq,
  stringify,
  type Document,
} from "yaml";
import { z } from "zod";
import { classifyCommand } from "./commands";
import {
  policyDocument,
  type Condition,
  type PolicyDocument,
} from "./policies";

/** Rule files declare the highest format they need, as Falco files do. */
export const ENGINE_VERSION = 1;

const MAX_FILE_BYTES = 1024 * 1024;

export type PolicySource = { name: string; text: string };
export type PolicyIssue = {
  file: string;
  line: number;
  column: number;
  message: string;
};
export type CompiledRule = {
  id: string;
  name: string;
  description: string | null;
  tags: string[];
  source: { file: string; line: number };
};
export type CompileResult =
  | {
      ok: true;
      document: PolicyDocument;
      rules: CompiledRule[];
      warnings: PolicyIssue[];
    }
  | { ok: false; issues: PolicyIssue[]; warnings: PolicyIssue[] };

const scalar = z.union([z.string(), z.number(), z.boolean()]);
const mode = z.enum(["append", "replace"]);
const refName = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/);

const conditionEntry = z.union([
  z.strictObject({ macro: refName }),
  z.strictObject({ field: z.string(), op: z.literal("in"), list: refName }),
  z.strictObject({ field: z.string(), op: z.string(), value: z.unknown() }),
]);
type ConditionEntry = z.infer<typeof conditionEntry>;

const versionItem = z.strictObject({
  required_engine_version: z.number().int().positive(),
});

const listItem = z.strictObject({
  list: refName,
  items: z.array(scalar).max(500),
  override: z.strictObject({ items: mode }).optional(),
});

const macroItem = z.strictObject({
  macro: refName,
  condition: z.array(conditionEntry).min(1).max(20),
  override: z.strictObject({ condition: mode }).optional(),
});

const fileResource = z.union([
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

const fileCommand = z.union([
  z.string().min(1).max(512),
  z.strictObject({ prefix: z.string().min(1).max(512) }),
  z.strictObject({
    list: refName,
    match: z.enum(["exact", "prefix"]).optional(),
  }),
]);

const ruleFields = {
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
type RuleFields = {
  [K in keyof typeof ruleFields]?: z.infer<(typeof ruleFields)[K]>;
};

const appendable = new Set(["condition", "tags"]);

const ruleItem = z.strictObject({
  rule: z.string().min(1).max(200),
  ...ruleFields,
  override: z
    .partialRecord(
      z.enum(Object.keys(ruleFields) as [string, ...string[]]),
      mode,
    )
    .optional(),
});

type Located<T> = T & { file: string; line: number; column: number };

class Collector {
  readonly issues: PolicyIssue[] = [];
  readonly warnings: PolicyIssue[] = [];
  error(at: Omit<PolicyIssue, "message">, message: string) {
    this.issues.push({ ...at, message });
  }
  warn(at: Omit<PolicyIssue, "message">, message: string) {
    this.warnings.push({ ...at, message });
  }
}

function locator(doc: Document, counter: LineCounter, file: string) {
  return (path: (string | number)[]) => {
    // The deepest node that exists, so a missing key points at its parent.
    for (let depth = path.length; depth >= 0; depth -= 1) {
      const node = doc.getIn(path.slice(0, depth), true) as
        { range?: [number, number, number] | null } | undefined;
      const offset = node?.range?.[0];
      if (offset !== undefined) {
        const { line, col } = counter.linePos(offset);
        return { file, line, column: col };
      }
    }
    return { file, line: 1, column: 1 };
  };
}

function kindOf(item: unknown) {
  if (typeof item !== "object" || item === null) return null;
  for (const key of ["required_engine_version", "list", "macro", "rule"])
    if (key in item) return key;
  return null;
}

type State = {
  lists: Map<string, Located<z.infer<typeof listItem>>>;
  macros: Map<string, Located<z.infer<typeof macroItem>>>;
  rules: Map<string, Located<RuleFields & { rule: string }>>;
};

function mergeNamed<T extends object>(
  store: Map<string, Located<T>>,
  kind: string,
  name: string,
  incoming: Located<T & { override?: Record<string, string> }>,
  collector: Collector,
) {
  const { override, ...fresh } = incoming;
  const existing = store.get(name);
  if (!override) {
    // Falco replaces silently; a later file quietly weakening a deny is too risky.
    if (existing)
      collector.error(
        incoming,
        `${kind} "${name}" is already defined at ${existing.file}:${existing.line}. Use override to change it.`,
      );
    else store.set(name, fresh as unknown as Located<T>);
    return;
  }
  if (!existing) {
    collector.error(
      incoming,
      `${kind} "${name}" has override but no earlier definition.`,
    );
    return;
  }
  const merged: Record<string, unknown> = { ...existing };
  const record = fresh as Record<string, unknown>;
  for (const [field, how] of Object.entries(override)) {
    if (record[field] === undefined) {
      collector.error(incoming, `override names "${field}" but it is not set.`);
      continue;
    }
    if (how === "append") {
      if (!Array.isArray(merged[field]) && merged[field] !== undefined) {
        collector.error(incoming, `"${field}" cannot be appended to.`);
        continue;
      }
      merged[field] = [
        ...((merged[field] as unknown[] | undefined) ?? []),
        ...(record[field] as unknown[]),
      ];
    } else merged[field] = record[field];
  }
  for (const field of Object.keys(record))
    if (
      !["file", "line", "column", kind].includes(field) &&
      record[field] !== undefined &&
      !(field in override)
    )
      collector.error(incoming, `"${field}" is set but not named in override.`);
  store.set(name, merged as Located<T>);
}

function readFile(source: PolicySource, state: State, collector: Collector) {
  const start = { file: source.name, line: 1, column: 1 };
  if (new TextEncoder().encode(source.text).length > MAX_FILE_BYTES) {
    collector.error(start, "File is larger than 1 MB.");
    return;
  }
  const counter = new LineCounter();
  // The core schema has no timestamps or binary, and "no" stays a string.
  const doc = parseDocument(source.text, {
    lineCounter: counter,
    schema: "core",
    uniqueKeys: true,
    prettyErrors: false,
  });
  for (const error of doc.errors) {
    const [offset] = error.pos;
    const { line, col } = counter.linePos(offset);
    collector.error({ file: source.name, line, column: col }, error.message);
  }
  if (doc.errors.length) return;
  if (doc.contents === null) return;
  if (!isSeq(doc.contents)) {
    collector.error(
      start,
      "A rules file is a list of list, macro and rule entries.",
    );
    return;
  }
  const at = locator(doc, counter, source.name);
  let items: unknown[];
  try {
    items = doc.toJS({ maxAliasCount: 50 }) as unknown[];
  } catch {
    collector.error(start, "Too many YAML aliases.");
    return;
  }
  items.forEach((raw, index) => {
    const here = at([index]);
    const kind = kindOf(raw);
    const schema = {
      required_engine_version: versionItem,
      list: listItem,
      macro: macroItem,
      rule: ruleItem,
    }[kind ?? ""];
    if (!schema || !isMap(doc.getIn([index], true))) {
      collector.error(
        here,
        "Expected a list, macro, rule or required_engine_version entry.",
      );
      return;
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      for (const issue of parsed.error.issues)
        collector.error(
          at([index, ...(issue.path as (string | number)[])]),
          `${issue.path.join(".") || kind}: ${issue.message}`,
        );
      return;
    }
    const value = parsed.data as Record<string, unknown>;
    if (kind === "required_engine_version") {
      if ((value.required_engine_version as number) > ENGINE_VERSION)
        collector.error(
          here,
          `This file needs engine version ${String(value.required_engine_version)}; this is ${ENGINE_VERSION}.`,
        );
      return;
    }
    const located = { ...value, ...here };
    if (kind === "list")
      mergeNamed(
        state.lists,
        "list",
        value.list as string,
        located as never,
        collector,
      );
    else if (kind === "macro")
      mergeNamed(
        state.macros,
        "macro",
        value.macro as string,
        located as never,
        collector,
      );
    else {
      const overridden = value.override as Record<string, string> | undefined;
      for (const [field, how] of Object.entries(overridden ?? {}))
        if (how === "append" && !appendable.has(field))
          collector.error(
            here,
            `"${field}" cannot be appended to; use replace.`,
          );
      mergeNamed(
        state.rules,
        "rule",
        value.rule as string,
        located as never,
        collector,
      );
    }
  });
}

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

function expandConditions(
  entries: ConditionEntry[],
  state: State,
  used: { lists: Set<string>; macros: Set<string> },
  at: Omit<PolicyIssue, "message">,
  collector: Collector,
  stack: string[] = [],
  budget = { left: MAX_CONDITIONS },
): unknown[] {
  return entries.flatMap((entry): unknown[] => {
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
      return expandConditions(
        macro.condition,
        state,
        used,
        at,
        collector,
        [...stack, entry.macro],
        budget,
      );
    }
    budget.left -= 1;
    if ("list" in entry) {
      const list = state.lists.get(entry.list);
      used.lists.add(entry.list);
      if (!list) {
        collector.error(at, `Unknown list "${entry.list}".`);
        return [];
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
type Used = { lists: Set<string>; macros: Set<string> };
type Place = Omit<PolicyIssue, "message">;

function resourceExpansions(
  rule: RuleFields,
  name: string,
  base: string,
  state: State,
  used: Used,
  at: Place,
  collector: Collector,
): Expansion[] | null {
  const resource = rule.resource as z.infer<typeof fileResource>;
  const shared = { tool: rule.tool, operation: rule.operation };
  if (!("list" in resource))
    return [{ ...shared, id: base, label: name, resource }];
  const list = state.lists.get(resource.list);
  used.lists.add(resource.list);
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
  command: z.infer<typeof fileCommand>,
  name: string,
  base: string,
  state: State,
  used: Used,
  at: Place,
  collector: Collector,
): Expansion[] | null {
  const fromList = typeof command === "object" && "list" in command;
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
  };
  for (const source of sources) readFile(source, state, collector);

  const used = { lists: new Set<string>(), macros: new Set<string>() };
  const output: Record<string, unknown>[] = [];
  const compiled: CompiledRule[] = [];

  for (const [name, rule] of state.rules) {
    const at = { file: rule.file, line: rule.line, column: rule.column };
    if (rule.enabled === false) {
      // A switched-off rule still counts as using what it names.
      expandConditions(rule.condition ?? [], state, used, at, new Collector());
      if (rule.resource && "list" in rule.resource)
        used.lists.add(rule.resource.list);
      if (typeof rule.command === "object" && "list" in rule.command)
        used.lists.add(rule.command.list);
      continue;
    }
    const needed =
      rule.command === undefined ? required : (["effect"] as const);
    const missing = needed.filter((field) => rule[field] === undefined);
    if (missing.length) {
      collector.error(at, `Rule "${name}" needs ${missing.join(", ")}.`);
      continue;
    }
    if (
      rule.command !== undefined &&
      (rule.tool ?? rule.operation ?? rule.resource) !== undefined
    ) {
      collector.error(
        at,
        `Rule "${name}" sets command, so it cannot also set tool, operation or resource.`,
      );
      continue;
    }
    const conditions = expandConditions(
      rule.condition ?? [],
      state,
      used,
      at,
      collector,
    ) as Condition[];
    const base = rule.id ?? slug(name).slice(0, 63);
    const shownName = rule.title ?? name;
    const expansions =
      rule.command === undefined
        ? resourceExpansions(rule, shownName, base, state, used, at, collector)
        : commandExpansions(
            rule.command,
            shownName,
            base,
            state,
            used,
            at,
            collector,
          );
    if (!expansions) continue;

    for (const expansion of expansions) {
      output.push({
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
      });
      compiled.push({
        id: expansion.id,
        name: expansion.label,
        description: rule.desc ?? null,
        tags: rule.tags ?? [],
        source: { file: rule.file, line: rule.line },
      });
    }
  }

  for (const [name, list] of state.lists)
    if (!used.lists.has(name))
      collector.warn(list, `List "${name}" is not used.`);
  for (const [name, macro] of state.macros)
    if (!used.macros.has(name))
      collector.warn(macro, `Macro "${name}" is not used.`);

  const parsed = policyDocument.safeParse({ version: 1, rules: output });
  if (!parsed.success)
    for (const issue of parsed.error.issues) {
      const index = typeof issue.path[1] === "number" ? issue.path[1] : null;
      const rule = index === null ? undefined : compiled[index];
      const field = issue.path.slice(2).join(".");
      collector.error(
        rule
          ? { file: rule.source.file, line: rule.source.line, column: 1 }
          : { file: sources[0]?.name ?? "rules", line: 1, column: 1 },
        `${rule ? `Rule "${rule.name}"` : "Rules"}${field ? ` ${field}` : ""}: ${issue.message}`,
      );
    }

  const { issues, warnings } = collector;
  if (issues.length || !parsed.success) return { ok: false, issues, warnings };
  return { ok: true, document: parsed.data, rules: compiled, warnings };
}

/** The opposite of compiling: rule files that compile back to this document. */
export function renderPolicies(document: PolicyDocument) {
  const seen = new Map<string, number>();
  const items = document.rules.map((rule) => {
    const uses = seen.get(rule.name) ?? 0;
    seen.set(rule.name, uses + 1);
    return {
      // Names must be unique in a file, so a repeated one is kept as its title.
      ...(uses
        ? { rule: `${rule.name} (${rule.id})`, title: rule.name }
        : { rule: rule.name }),
      id: rule.id,
      tool: rule.toolKey,
      operation: rule.operationKey,
      resource: rule.resource,
      ...(rule.conditions.length ? { condition: rule.conditions } : {}),
      effect: rule.effect,
      ...(rule.agentKey ? { agent: rule.agentKey } : {}),
      ...(rule.installationName ? { installation: rule.installationName } : {}),
      ...(rule.expiresAt ? { expires: rule.expiresAt } : {}),
    };
  });
  return `# Nodrail rules. Keep each id so a rule stays the same rule when renamed.\n${items.length ? stringify(items, { lineWidth: 0 }) : "[]\n"}`;
}
