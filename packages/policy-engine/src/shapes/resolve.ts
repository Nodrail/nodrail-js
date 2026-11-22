// From declared shapes to resolved ones: infer each type, make every default
// explicit, merge `extends`, and check the limits and roles that hold for a
// shape wherever it is attached.
import type { PropertyDecl, ShapeDecl } from "./grammar.ts";
import { LIMITS, isDate } from "./limits.ts";
import { checkRoles } from "./roles.ts";
import type {
  ContractIssue,
  PropertyType,
  ResolvedProperty,
  ResolvedShape,
} from "./types.ts";

export type Path = (string | number)[];
export type Report = (code: string, path: Path, message: string) => void;

export const collector = () => {
  const issues: ContractIssue[] = [];
  const report: Report = (code, path, message) =>
    issues.push({ code, path, message });
  return { issues, report };
};

const INFERRED = [
  ["values", "enum"],
  ["properties", "object"],
  ["of", "list"],
] as const;

function typeOf(
  decl: PropertyDecl,
  at: Path,
  report: Report,
): PropertyType | null {
  const given = INFERRED.filter(([key]) => decl[key] !== undefined);
  if (given.length > 1) {
    report(
      "grammar",
      at,
      `Give one of values, properties or of, not ${given.map(([key]) => key).join(" and ")}`,
    );
    return null;
  }
  const [key, inferred] = given[0] ?? [];
  if (
    inferred &&
    decl.type &&
    (inferred === "enum" || decl.type !== inferred)
  ) {
    report(
      "grammar",
      [...at, "type"],
      `type ${decl.type} doesn't go with ${key}`,
    );
    return null;
  }
  const type = inferred ?? decl.type;
  if (!type || ((type === "object" || type === "list") && !inferred)) {
    report(
      "grammar",
      at,
      "Give type with its bounds, or values, properties or of",
    );
    return null;
  }
  return type;
}

const whole = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

type Bounds = { min: number | string | null; max: number | string | null };

/** min and max as this type reads them, or null when they don't fit it. */
function bounds(
  decl: PropertyDecl,
  type: PropertyType,
  at: Path,
  report: Report,
): Bounds | null {
  const { min = null, max = null } = decl;
  const set = (["min", "max"] as const).filter(
    (key) => decl[key] !== undefined,
  );
  const fits: Record<PropertyType, (value: unknown) => boolean> = {
    string: whole,
    list: whole,
    integer: Number.isSafeInteger,
    number: (value) => typeof value === "number",
    date: isDate,
    enum: () => false,
    boolean: () => false,
    object: () => false,
  };
  for (const key of set)
    if (!fits[type](decl[key])) {
      report("grammar", [...at, key], `${key} doesn't fit a ${type}`);
      return null;
    }
  if (min !== null && max !== null && min > max) {
    report("grammar", [...at, "min"], "min is above max");
    return null;
  }
  const ceiling =
    type === "string"
      ? LIMITS.stringMax
      : type === "list"
        ? LIMITS.listMax
        : null;
  if (ceiling !== null && typeof max === "number" && max > ceiling) {
    report("grammar", [...at, "max"], `A ${type} holds at most ${ceiling}`);
    return null;
  }
  return { min, max };
}

function misplaced(
  decl: PropertyDecl,
  type: PropertyType,
  at: Path,
  report: Report,
) {
  if (decl.unit !== undefined && type !== "integer" && type !== "number") {
    report("grammar", [...at, "unit"], "Only a number has a unit");
    return true;
  }
  return false;
}

/** A property as declared, resolved; null after reporting why it can't be. */
export function resolveProperty(
  decl: PropertyDecl,
  at: Path,
  report: Report,
  item = false,
): ResolvedProperty | null {
  if (item) {
    const extra = (
      ["optional", "role", "report", "classification"] as const
    ).find((key) => decl[key] !== undefined);
    if (extra) {
      report(
        "grammar",
        [...at, extra],
        `Set ${extra} on the list, not its items`,
      );
      return null;
    }
  }
  const type = typeOf(decl, at, report);
  if (!type || misplaced(decl, type, at, report)) return null;
  const range = bounds(decl, type, at, report);
  if (!range) return null;
  const common = {
    optional: decl.optional ?? false,
    for: decl.for ?? null,
    report: decl.report ?? null,
    classification: decl.classification ?? null,
    role: decl.role ?? null,
  };
  return shaped(decl, { type, range, common }, at, report);
}

type Common = Pick<
  ResolvedProperty,
  "optional" | "for" | "report" | "classification" | "role"
>;
type Parts = { type: PropertyType; range: Bounds; common: Common };

const num = (value: number | string | null) => value as number | null;

function container(
  decl: PropertyDecl,
  { type, range, common }: Parts,
  at: Path,
  report: Report,
): ResolvedProperty | null {
  if (type === "object") {
    const properties = resolveProperties(
      decl.properties!,
      [...at, "properties"],
      report,
    );
    return properties && { ...common, type, properties };
  }
  const of = resolveProperty(decl.of!, [...at, "of"], report, true);
  if (!of) return null;
  if (of.type === "list") {
    report(
      "grammar",
      [...at, "of"],
      "A list of lists has no path; use a list of objects",
    );
    return null;
  }
  return {
    ...common,
    type: "list",
    min: num(range.min) ?? 0,
    max: num(range.max) ?? LIMITS.listMax,
    of,
  };
}

function shaped(
  decl: PropertyDecl,
  parts: Parts,
  at: Path,
  report: Report,
): ResolvedProperty | null {
  const { type, range, common } = parts;
  switch (type) {
    case "string":
      return {
        ...common,
        type,
        min: num(range.min) ?? 0,
        max: num(range.max) ?? LIMITS.stringMax,
      };
    case "enum":
      return { ...common, type, values: [...decl.values!] };
    case "integer":
    case "number":
      return {
        ...common,
        type,
        min: num(range.min),
        max: num(range.max),
        unit: decl.unit ?? null,
      };
    case "boolean":
      return { ...common, type };
    case "date":
      return {
        ...common,
        type,
        min: range.min as string | null,
        max: range.max as string | null,
      };
    default:
      return container(decl, parts, at, report);
  }
}

export function resolveProperties(
  decls: Record<string, PropertyDecl>,
  at: Path,
  report: Report,
) {
  const resolved: Record<string, ResolvedProperty> = {};
  let ok = true;
  for (const [name, decl] of Object.entries(decls)) {
    const property = resolveProperty(decl, [...at, name], report);
    if (property) resolved[name] = property;
    else ok = false;
  }
  return ok ? resolved : null;
}

/** Each named property with its level and path, list items included. */
export function* walk(
  properties: Record<string, ResolvedProperty>,
  level = 1,
  path: string[] = [],
): Generator<{
  name: string;
  property: ResolvedProperty;
  level: number;
  path: string[];
}> {
  for (const [name, property] of Object.entries(properties)) {
    const here = [...path, name];
    yield { name, property, level, path: here };
    const inner = property.type === "list" ? property.of : property;
    const step = property.type === "list" ? 2 : 1;
    if (inner.type === "object")
      yield* walk(inner.properties, level + step, here);
  }
}

/** Depth and size: a list adds a level, and item properties count once. */
function checkLimits(shape: ResolvedShape, at: Path, report: Report) {
  let named = 0;
  for (const { property, level, path } of walk(shape.properties)) {
    named += 1;
    const deepest =
      property.type === "list" && property.of.type !== "object"
        ? level + 1
        : level;
    if (deepest > LIMITS.depth) {
      report(
        "depth",
        [...at, ...path],
        `Nested ${deepest} levels deep; at most ${LIMITS.depth}`,
      );
      return;
    }
  }
  if (named > LIMITS.properties)
    report(
      "property-count",
      at,
      `${named} properties; at most ${LIMITS.properties}`,
    );
}

/** Reporting can't reach a classified value, and saying so is an error, not ignored. */
function checkReporting(shape: ResolvedShape, at: Path, report: Report) {
  const visit = (
    properties: Record<string, ResolvedProperty>,
    classified: boolean,
    path: Path,
  ) => {
    for (const [name, property] of Object.entries(properties)) {
      const here = [...path, name];
      const hidden = classified || property.classification !== null;
      if (hidden && property.report === true)
        report(
          "report-classified",
          [...here, "report"],
          "A secret or pii value is never reported; drop report: true",
        );
      const inner = property.type === "list" ? property.of : property;
      if (inner.type === "object") visit(inner.properties, hidden, here);
    }
  };
  visit(shape.properties, false, at);
}

/** Every shape, with `extends` merged one level deep. */
export function resolveShapes(
  decls: Record<string, ShapeDecl>,
  report: Report,
) {
  const shapes = new Map<string, ResolvedShape>();
  for (const [name, decl] of Object.entries(decls)) {
    const at = ["shapes", name];
    let declared = decl.properties;
    let shapeFor = decl.for ?? null;
    if (decl.extends !== undefined) {
      const parent = decls[decl.extends];
      if (!parent) {
        report(
          "unknown-shape",
          [...at, "extends"],
          `No shape named ${decl.extends}`,
        );
        continue;
      }
      if (decl.extends === name || parent.extends !== undefined) {
        report(
          "extends-chain",
          [...at, "extends"],
          "extends is one level: the parent can't extend another shape",
        );
        continue;
      }
      // A child replaces a whole property by name, never a piece of one.
      declared = { ...parent.properties, ...decl.properties };
      shapeFor = decl.for ?? parent.for ?? null;
    }
    let failed = false;
    const local: Report = (...issue) => {
      failed = true;
      report(...issue);
    };
    const properties = resolveProperties(
      declared,
      [...at, "properties"],
      local,
    );
    if (!properties) continue;
    const shape = { for: shapeFor, properties };
    checkLimits(shape, [...at, "properties"], local);
    checkRoles(shape, [...at, "properties"], local);
    checkReporting(shape, [...at, "properties"], local);
    if (!failed) shapes.set(name, shape);
  }
  return shapes;
}
