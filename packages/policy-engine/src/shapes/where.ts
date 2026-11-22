// `where:` against a resolved shape: exact value, {min,max} or {in}. Paths
// must exist and have a compatible type. No expressions, no conversions,
// no path into a list.
import type { ConditionDecl, WhereDecl } from "./grammar.ts";
import { isDate } from "./limits.ts";
import type { Path, Report } from "./resolve.ts";
import type {
  CompiledCondition,
  ResolvedProperty,
  ResolvedShape,
} from "./types.ts";

/**
 * What a path is read against: one shape, or named roots such as `input`
 * and `result`. `reported` is the projection, for a consumer that only
 * ever sees reported values.
 */
export type Scope = {
  roots: Record<string, { shape: ResolvedShape; reported?: ResolvedShape }>;
  /** True when paths start with a root's name, as rules write `input.amount`. */
  prefixed: boolean;
};

export const single = (
  shape: ResolvedShape,
  reported?: ResolvedShape,
): Scope => ({
  roots: { "": { shape, ...(reported ? { reported } : {}) } },
  prefixed: false,
});

type Found =
  { property: ResolvedProperty } | { problem: [code: string, message: string] };

function walkTo(shape: ResolvedShape, path: string[]): Found {
  let properties = shape.properties;
  const last = path.length - 1;
  for (const [index, key] of path.slice(0, last).entries()) {
    const property = Object.hasOwn(properties, key)
      ? properties[key]
      : undefined;
    const here = path.slice(0, index + 1).join(".");
    if (!property) return { problem: ["path", `No property ${here}`] };
    if (property.type === "list")
      return {
        problem: [
          "path-through-list",
          `${here} is a list; lists are never searched or summed`,
        ],
      };
    if (property.type !== "object")
      return { problem: ["path", `${here} has no properties`] };
    properties = property.properties;
  }
  const property = Object.hasOwn(properties, path[last]!)
    ? properties[path[last]!]
    : undefined;
  return property
    ? { property }
    : { problem: ["path", `No property ${path.join(".")}`] };
}

/** The property a dotted path names in the scope, or a reported problem. */
export function propertyAt(
  scope: Scope,
  text: string,
  at: Path,
  report: Report,
) {
  const parts = text.split(".");
  const root = scope.prefixed ? parts[0]! : "";
  const rest = scope.prefixed ? parts.slice(1) : parts;
  const target = Object.hasOwn(scope.roots, root)
    ? scope.roots[root]
    : undefined;
  if (!target || !rest.length) {
    const roots = Object.keys(scope.roots).join(", ") || "none here";
    report("path", at, `A path starts with one of: ${roots}`);
    return null;
  }
  const found = walkTo(target.shape, rest);
  if ("problem" in found) {
    report(found.problem[0], at, found.problem[1]);
    return null;
  }
  if (target.reported && "problem" in walkTo(target.reported, rest)) {
    report(
      "not-reported",
      at,
      `${text} isn't reported, so this consumer never sees it; add report: true`,
    );
    return null;
  }
  return { property: found.property, path: parts };
}

const isNumber = (type: string) => type === "integer" || type === "number";

function exact(property: ResolvedProperty, value: string | number | boolean) {
  switch (property.type) {
    case "enum":
      return typeof value === "string" && property.values.includes(value);
    case "string":
      return typeof value === "string";
    case "date":
      return isDate(value);
    case "integer":
      return Number.isSafeInteger(value);
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    default:
      return false;
  }
}

function rangeFits(
  property: ResolvedProperty,
  range: { min?: number | string; max?: number | string },
) {
  const ends = [range.min, range.max].filter((end) => end !== undefined);
  if (isNumber(property.type))
    return ends.every((end) => typeof end === "number");
  if (property.type === "date") return ends.every((end) => isDate(end));
  return false;
}

function compileOne(
  property: ResolvedProperty,
  path: string[],
  decl: ConditionDecl,
): CompiledCondition | null {
  if (typeof decl !== "object")
    return exact(property, decl) ? { path, op: "eq", value: decl } : null;
  if ("in" in decl) {
    const fits = decl.in.every(
      (item) => exact(property, item) && property.type !== "date",
    );
    return fits &&
      (property.type === "enum" ||
        property.type === "string" ||
        property.type === "integer")
      ? { path, op: "in", values: [...decl.in] }
      : null;
  }
  if (!rangeFits(property, decl)) return null;
  const { min = null, max = null } = decl;
  if (min !== null && max !== null && min > max) return null;
  return { path, op: "range", min, max };
}

/** Compiled conditions, or null after reporting each one that can't hold. */
export function compileWhere(
  where: WhereDecl,
  scope: Scope,
  at: Path,
  report: Report,
) {
  const compiled: CompiledCondition[] = [];
  let ok = true;
  for (const [text, decl] of Object.entries(where)) {
    const here = [...at, text];
    const found = propertyAt(scope, text, here, report);
    const condition = found && compileOne(found.property, found.path, decl);
    if (found && !condition)
      report(
        "path-type",
        here,
        `This condition can't hold for ${text}, a ${found.property.type}`,
      );
    if (condition) compiled.push(condition);
    else ok = false;
  }
  return ok ? compiled : null;
}
