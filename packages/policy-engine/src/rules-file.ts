import { parseDocument, LineCounter, isMap, isSeq, type Document } from "yaml";
import { z } from "zod";
import {
  listItem,
  macroItem,
  mode,
  ruleFields,
  versionItem,
  type RuleFields,
} from "./file-fields.ts";
import type { PolicyDocument } from "./policies.ts";
import {
  budgetItem,
  gateItem,
  type BudgetFields,
  type GateFields,
} from "./run-entries.ts";

export {
  fileCommand,
  fileResource,
  type ConditionEntry,
  type RuleFields,
} from "./file-fields.ts";

/** Rule files declare the highest format they need, as Falco files do. */
/** 2 adds `op: contains` with a list; 3 adds gates and budgets (document version 2). */
export const ENGINE_VERSION = 3;

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

const appendable = new Set(["condition", "tags", "requires"]);

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

type Place = { file: string; line: number; column: number };

type Located<T> = T & { file: string; line: number; column: number };

export class Collector {
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
  for (const key of [
    "required_engine_version",
    "list",
    "macro",
    "rule",
    "gate",
    "budget",
  ])
    if (key in item) return key;
  return null;
}

export type State = {
  lists: Map<string, Located<z.infer<typeof listItem>>>;
  macros: Map<string, Located<z.infer<typeof macroItem>>>;
  rules: Map<string, Located<RuleFields & { rule: string }>>;
  gates: Map<string, Located<GateFields & { gate: string }>>;
  budgets: Map<string, Located<BudgetFields & { budget: string }>>;
};

/** Where a named entry goes, and where its problems are reported. */
type Target<T> = {
  store: Map<string, Located<T>>;
  kind: string;
  collector: Collector;
};

function mergeNamed<T extends object>(
  { store, kind, collector }: Target<T>,
  name: string,
  incoming: Located<T & { override?: Record<string, string> }>,
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

const schemas = {
  required_engine_version: versionItem,
  list: listItem,
  macro: macroItem,
  rule: ruleItem,
  gate: gateItem,
  budget: budgetItem,
};

/** The file as YAML entries, or null with every problem reported. */
function parseEntries(source: PolicySource, collector: Collector) {
  const start = { file: source.name, line: 1, column: 1 };
  if (new TextEncoder().encode(source.text).length > MAX_FILE_BYTES) {
    collector.error(start, "File is larger than 1 MB.");
    return null;
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
    const { line, col } = counter.linePos(error.pos[0]);
    collector.error({ file: source.name, line, column: col }, error.message);
  }
  if (doc.errors.length || doc.contents === null) return null;
  if (!isSeq(doc.contents)) {
    collector.error(
      start,
      "A rules file is a list of list, macro, rule, gate and budget entries.",
    );
    return null;
  }
  try {
    const items = doc.toJS({ maxAliasCount: 50 }) as unknown[];
    return { doc, items, at: locator(doc, counter, source.name) };
  } catch {
    collector.error(start, "Too many YAML aliases.");
    return null;
  }
}

type Entries = NonNullable<ReturnType<typeof parseEntries>>;

/** One entry checked against its schema, or null with its problems reported. */
function checkEntry(
  { doc, at }: Entries,
  raw: unknown,
  index: number,
  collector: Collector,
) {
  const kind = kindOf(raw);
  const schema = kind ? schemas[kind as keyof typeof schemas] : undefined;
  if (!schema || !isMap(doc.getIn([index], true))) {
    collector.error(
      at([index]),
      "Expected a list, macro, rule, gate, budget or required_engine_version entry.",
    );
    return null;
  }
  const parsed = schema.safeParse(raw);
  if (parsed.success)
    return { kind, value: parsed.data as Record<string, unknown> };
  for (const issue of parsed.error.issues)
    collector.error(
      at([index, ...(issue.path as (string | number)[])]),
      `${issue.path.join(".") || kind}: ${issue.message}`,
    );
  return null;
}

/** Adds a checked entry to what has been read so far. */
function addEntry(
  { kind, value }: { kind: string | null; value: Record<string, unknown> },
  here: Place,
  state: State,
  collector: Collector,
) {
  if (kind === "required_engine_version") {
    if ((value.required_engine_version as number) > ENGINE_VERSION)
      collector.error(
        here,
        `This file needs engine version ${String(value.required_engine_version)}; this is ${ENGINE_VERSION}.`,
      );
    return;
  }
  const located = { ...value, ...here } as never;
  if (kind === "list")
    return mergeNamed(
      { store: state.lists, kind, collector },
      value.list as string,
      located,
    );
  if (kind === "macro")
    return mergeNamed(
      { store: state.macros, kind, collector },
      value.macro as string,
      located,
    );
  const overridden = value.override as Record<string, string> | undefined;
  for (const [field, how] of Object.entries(overridden ?? {}))
    if (how === "append" && !appendable.has(field))
      collector.error(here, `"${field}" cannot be appended to; use replace.`);
  if (kind === "gate")
    return mergeNamed(
      { store: state.gates, kind, collector },
      value.gate as string,
      located,
    );
  if (kind === "budget")
    return mergeNamed(
      { store: state.budgets, kind, collector },
      value.budget as string,
      located,
    );
  mergeNamed(
    { store: state.rules, kind: "rule", collector },
    value.rule as string,
    located,
  );
}

export function readFile(
  source: PolicySource,
  state: State,
  collector: Collector,
) {
  const entries = parseEntries(source, collector);
  if (!entries) return;
  entries.items.forEach((raw, index) => {
    const entry = checkEntry(entries, raw, index, collector);
    if (entry) addEntry(entry, entries.at([index]), state, collector);
  });
}
