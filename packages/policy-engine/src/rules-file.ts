import { parseDocument, LineCounter, isMap, isSeq } from "yaml";
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
import { issueMessage } from "./removed-syntax.ts";
import {
  entryWhere,
  issuePlace,
  layered,
  pick,
  type Place,
  type Where,
} from "./positions.ts";
import {
  budgetItem,
  contractsItem,
  gateItem,
  type ContractsEntry,
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
/**
 * 2 adds `op: contains` with a list; 3 adds gates and budgets (document
 * version 2); 4 adds declared contracts: a `contracts` entry and gate
 * requirements with `where`, `authority` and `subject` (document version 3).
 * Engines up to 3 refuse a file that asks for 4, so a contract is never
 * read with its checks ignored.
 */
export const ENGINE_VERSION = 5;

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

/** An entry as read, with where it is and where each of its fields is. */
export type Located<T> = T & Place & { locate: Where };

// Only the place is kept, so an entry passed as `at` adds none of its fields.
const toIssue = ({ file, line, column }: Place, message: string) => ({
  file,
  line,
  column,
  message,
});

export class Collector {
  readonly issues: PolicyIssue[] = [];
  readonly warnings: PolicyIssue[] = [];
  error(at: Place, message: string) {
    this.issues.push(toIssue(at, message));
  }
  warn(at: Place, message: string) {
    this.warnings.push(toIssue(at, message));
  }
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
    "contracts",
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
  /** The one `contracts` entry, engine version 4. */
  contracts?: Located<{ contracts: ContractsEntry }>;
  /** The engine version each file asks for, by file name. */
  levels?: Map<string, number>;
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
        pick(incoming, [[kind]]),
        `${kind} "${name}" is already defined at ${existing.file}:${existing.line}. Use override to change it.`,
      );
    else store.set(name, fresh as unknown as Located<T>);
    return;
  }
  if (!existing) {
    collector.error(
      pick(incoming, [["override"]], "key"),
      `${kind} "${name}" has override but no earlier definition.`,
    );
    return;
  }
  const merged: Record<string, unknown> = {
    ...existing,
    locate: layered(existing, incoming.locate, override),
  };
  const record = fresh as Record<string, unknown>;
  for (const [field, how] of Object.entries(override)) {
    if (record[field] === undefined) {
      collector.error(
        pick(incoming, [["override", field]], "key"),
        `override names "${field}" but it is not set.`,
      );
      continue;
    }
    if (how === "append") {
      if (!Array.isArray(merged[field]) && merged[field] !== undefined) {
        collector.error(
          pick(incoming, [["override", field]]),
          `"${field}" cannot be appended to.`,
        );
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
      !["file", "line", "column", "locate", kind].includes(field) &&
      record[field] !== undefined &&
      !(field in override)
    )
      collector.error(
        pick(incoming, [[field]], "key"),
        `"${field}" is set but not named in override.`,
      );
  store.set(name, merged as Located<T>);
}

const schemas = {
  required_engine_version: versionItem,
  list: listItem,
  macro: macroItem,
  rule: ruleItem,
  gate: gateItem,
  budget: budgetItem,
  contracts: contractsItem,
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
    // Each entry with where it starts and a way to find its fields.
    const entry = (index: number) => {
      const locate = entryWhere(doc, counter, source.name, index);
      return { ...(locate([]) ?? start), locate };
    };
    return { doc, items, entry };
  } catch {
    collector.error(start, "Too many YAML aliases.");
    return null;
  }
}

type Entries = NonNullable<ReturnType<typeof parseEntries>>;

/** One entry checked against its schema, or null with its problems reported. */
function checkEntry(
  { doc, entry }: Entries,
  raw: unknown,
  index: number,
  collector: Collector,
) {
  const kind = kindOf(raw);
  const schema = kind ? schemas[kind as keyof typeof schemas] : undefined;
  const here = entry(index);
  if (!schema || !isMap(doc.getIn([index], true))) {
    collector.error(
      here,
      "Expected a list, macro, rule, gate, budget, contracts or required_engine_version entry.",
    );
    return null;
  }
  const parsed = schema.safeParse(raw);
  if (parsed.success)
    return { kind, value: parsed.data as Record<string, unknown> };
  for (const issue of parsed.error.issues)
    collector.error(
      issuePlace(here, issue),
      `${issue.path.join(".") || kind}: ${issueMessage(issue)}`,
    );
  return null;
}

/** The engine version a file asks for, and the one contracts entry. */
function addFileEntry(
  { kind, value }: { kind: string; value: Record<string, unknown> },
  here: Located<object>,
  state: State,
  collector: Collector,
) {
  if (kind === "contracts") {
    if (state.contracts)
      collector.error(
        pick(here, [["contracts"]], "key"),
        `contracts is already declared at ${state.contracts.file}:${state.contracts.line}; declare them once.`,
      );
    else state.contracts = { ...value, ...here } as never;
    return;
  }
  const level = value.required_engine_version as number;
  state.levels ??= new Map();
  state.levels.set(
    here.file,
    Math.max(level, state.levels.get(here.file) ?? 0),
  );
  if (level > ENGINE_VERSION)
    collector.error(
      pick(here, [["required_engine_version"]]),
      `This file needs engine version ${String(level)}; this is ${ENGINE_VERSION}.`,
    );
}

/** Adds a checked entry to what has been read so far. */
function addEntry(
  { kind, value }: { kind: string | null; value: Record<string, unknown> },
  here: Located<object>,
  state: State,
  collector: Collector,
) {
  if (kind === "required_engine_version" || kind === "contracts")
    return addFileEntry({ kind, value }, here, state, collector);
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
      collector.error(
        pick(here, [["override", field]]),
        `"${field}" cannot be appended to; use replace.`,
      );
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
    if (entry) addEntry(entry, entries.entry(index), state, collector);
  });
}
