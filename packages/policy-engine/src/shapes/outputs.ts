// Consumers that run off the machine: views (C05), insights (C09) and
// notifications (C10). They read a binding's projection, so every path they
// name must be reported.
import type { z } from "zod";
import type { sourceDecl } from "./grammar.ts";
import { bound, dotted, type Registry } from "./registry.ts";
import type { Path } from "./resolve.ts";
import type { PropertyType } from "./types.ts";
import { compileWhere, propertyAt, single, type Scope } from "./where.ts";

const M = "nodrail.yaml";

const SOURCE_BINDING = {
  receipt: "receipt",
  evidence: "evidence",
  memory: "memory",
  approval: "request",
} as const;

/** A view, insight or notification's source: its binding, read through the projection. */
function sourceOf(
  registry: Registry,
  source: z.infer<typeof sourceDecl>,
  at: Path,
) {
  const [kind, name] = Object.entries(source)[0] as [
    keyof typeof SOURCE_BINDING,
    string,
  ];
  const found = bound(registry, `${SOURCE_BINDING[kind]}:${name}`);
  if (!found)
    registry.report(
      "unknown-reference",
      [...at, "source"],
      `No ${kind} named ${name}`,
    );
  return (
    found && {
      ...found,
      kind,
      scope: single(found.shape, found.projection.shape),
    }
  );
}

type Paths = { paths: string[]; at: Path; types: PropertyType[] };

function pathsOf(
  registry: Registry,
  scope: Scope,
  { paths, at, types }: Paths,
) {
  paths.forEach((path, index) => {
    const found = propertyAt(scope, path, [...at, index], registry.report);
    if (found && !types.includes(found.property.type))
      registry.report(
        "path-type",
        [...at, index],
        `${path} is a ${found.property.type}; expected ${types.join(", ")}`,
      );
  });
}

const SCALARS: PropertyType[] = [
  "string",
  "enum",
  "integer",
  "number",
  "boolean",
  "date",
];
const BOUNDED: PropertyType[] = [
  "enum",
  "boolean",
  "date",
  "integer",
  "number",
];

function compileViews(registry: Registry) {
  for (const [name, view] of Object.entries(registry.manifest.views ?? {})) {
    const at = [M, "views", name];
    const found = sourceOf(registry, view.source, at);
    if (!found) continue;
    pathsOf(registry, found.scope, {
      paths: view.columns,
      at: [...at, "columns"],
      types: SCALARS,
    });
    pathsOf(registry, found.scope, {
      paths: view.filters,
      at: [...at, "filters"],
      types: BOUNDED,
    });
    registry.consumers.push({
      consumer: "C05",
      at: dotted(at),
      bindings: [found.binding.name],
      conditions: [],
      detail: { columns: view.columns, filters: view.filters },
    });
  }
}

function sumPath(registry: Registry, scope: Scope, path: string, at: Path) {
  const target = propertyAt(scope, path, at, registry.report);
  if (!target) return;
  const { property } = target;
  if (property.type !== "integer" && property.type !== "number")
    registry.report(
      "path-type",
      at,
      `${path} is a ${property.type}; a sum reads a number`,
    );
  else if (property.unit === null)
    registry.report("unit", at, "A sum needs a declared unit");
}

function compileInsights(registry: Registry) {
  for (const [name, insight] of Object.entries(
    registry.manifest.insights ?? {},
  )) {
    const at = [M, "insights", name];
    const found = sourceOf(registry, insight.source, at);
    if (!found) continue;
    if (
      (insight.measure === "verdicts" || insight.measure === "rework") &&
      found.kind !== "receipt"
    )
      registry.report(
        "path-type",
        [...at, "measure"],
        `${insight.measure} reads receipts`,
      );
    if (insight.path)
      sumPath(registry, found.scope, insight.path, [...at, "path"]);
    pathsOf(registry, found.scope, {
      paths: insight.group,
      at: [...at, "group"],
      types: ["enum", "boolean"],
    });
    registry.consumers.push({
      consumer: "C09",
      at: dotted(at),
      bindings: [found.binding.name],
      conditions: [],
      detail: {
        measure: insight.measure,
        path: insight.path ?? null,
        group: insight.group,
      },
    });
  }
}

function compileNotifications(registry: Registry) {
  for (const [name, note] of Object.entries(
    registry.manifest.notifications ?? {},
  )) {
    const at = [M, "notifications", name];
    const found = sourceOf(registry, note.source, at);
    if (!found) continue;
    pathsOf(registry, found.scope, {
      paths: note.fields,
      at: [...at, "fields"],
      types: SCALARS,
    });
    const conditions = note.where
      ? compileWhere(note.where, found.scope, [...at, "where"], registry.report)
      : [];
    registry.consumers.push({
      consumer: "C10",
      at: dotted(at),
      bindings: [found.binding.name],
      conditions: conditions ?? [],
      detail: { fields: note.fields, to: note.to },
    });
  }
}

/** C05, C09 and C10: everything read off the machine reads only reported fields. */
export function compileOutputs(registry: Registry) {
  compileViews(registry);
  compileInsights(registry);
  compileNotifications(registry);
}
