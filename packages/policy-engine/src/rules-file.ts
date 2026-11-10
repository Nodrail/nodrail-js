import {
  parseDocument,
  LineCounter,
  isMap,
  isSeq,
  stringify,
  type Document,
} from "yaml";
import { z } from "zod";
import type { PolicyDocument } from "./policies.ts";

/** Rule files declare the highest format they need, as Falco files do. */
/** 2 adds `op: contains` with a list. The compiled document is still version 1. */
export const ENGINE_VERSION = 2;

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
  z.strictObject({
    field: z.string(),
    op: z.enum(["in", "contains"]),
    list: refName,
  }),
  z.strictObject({ field: z.string(), op: z.string(), value: z.unknown() }),
]);
export type ConditionEntry = z.infer<typeof conditionEntry>;

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
export type RuleFields = {
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
  for (const key of ["required_engine_version", "list", "macro", "rule"])
    if (key in item) return key;
  return null;
}

export type State = {
  lists: Map<string, Located<z.infer<typeof listItem>>>;
  macros: Map<string, Located<z.infer<typeof macroItem>>>;
  rules: Map<string, Located<RuleFields & { rule: string }>>;
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
      "A rules file is a list of list, macro and rule entries.",
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
      "Expected a list, macro, rule or required_engine_version entry.",
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
