// Roles that hold wherever a shape is attached: placement, form and at most
// one of each. How many an attachment needs is checked where it binds.
import { VERDICT_VALUE } from "./limits.ts";
import { walk, type Path, type Report } from "./resolve.ts";
import type { ResolvedProperty, ResolvedShape } from "./types.ts";

/** Roles that hold wherever the shape is attached; how many is the attachment's. */
export function checkRoles(shape: ResolvedShape, at: Path, report: Report) {
  const seen = new Set<string>();
  for (const { property, level, path } of walk(shape.properties)) {
    const here = [...at, ...path];
    if (property.role === null) continue;
    if (level !== 1) {
      report(
        "role-placement",
        here,
        `role: ${property.role} goes on a top-level property`,
      );
      continue;
    }
    if (seen.has(property.role))
      report("role-count", here, `Two properties have role: ${property.role}`);
    seen.add(property.role);
    const problem = roleProblem(property);
    if (problem) report("role-placement", here, problem);
  }
}

function roleProblem(property: ResolvedProperty): string | null {
  if (property.classification)
    return `A ${property.role} property can't be classified ${property.classification}`;
  switch (property.role) {
    case "verdict":
    case "kind":
      if (property.type !== "enum" || property.optional)
        return `role: ${property.role} is a required enum`;
      if (
        property.role === "verdict" &&
        !property.values.every((value) => VERDICT_VALUE.test(value))
      )
        return "Verdicts are words of up to 32 characters: a-z, 0-9, _ and -";
      return null;
    case "findings":
      return findingsProblem(property);
    case "usage":
      return usageProblem(property);
    default:
      return null;
  }
}

const countable = (property: ResolvedProperty) =>
  property.type === "integer" &&
  !property.optional &&
  property.min !== null &&
  property.min >= 0;

function findingsProblem(property: ResolvedProperty) {
  if (
    property.type === "object" &&
    Object.values(property.properties).every(countable)
  )
    return null;
  if (property.type === "list" && property.of.type === "enum") return null;
  return "role: findings is a list of enum categories, or an object of required integer counts with min: 0";
}

function usageProblem(property: ResolvedProperty) {
  if (property.type !== "object")
    return "role: usage is an object of tokens and usd";
  for (const [name, inner] of Object.entries(property.properties)) {
    const fits =
      (name === "tokens" && inner.type === "integer") ||
      (name === "usd" && (inner.type === "number" || inner.type === "integer"));
    if (!fits || inner.min === null || inner.min < 0)
      return "role: usage holds only tokens (integer) and usd (number), each with min: 0";
  }
  return null;
}
