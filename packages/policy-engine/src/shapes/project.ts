// The reporting projection: the part of a contract, and of each value, that
// may leave the machine. Derived, versioned and digested apart from the full
// contract. A projected schema is itself a resolved shape, so the validator
// that checks full values checks projected ones too.
import { contractDigest } from "./digest.ts";
import type { ResolvedProperty, ResolvedShape } from "./types.ts";

export type Projection = {
  /** The reported properties only, with their types, bounds and `for` text. */
  shape: ResolvedShape;
  /** Top-most paths left out: names only, never values or descriptions. */
  withheld: string[];
  digest: string;
};

/**
 * Whether a property is reported. Every custom property is opt-in, whatever
 * its type; a secret or pii classification, its own or an ancestor's, always
 * wins; `report: true` on an object or list opts in what it holds unless a
 * child says `report: false`. The verdict and usage roles keep their
 * built-in behavior: reported unless they say `report: false`.
 */
function reportedHere(
  property: ResolvedProperty,
  inherited: boolean,
  hidden: boolean,
) {
  if (hidden) return false;
  if (property.report !== null) return property.report;
  if (property.role === "verdict" || property.role === "usage") return true;
  return inherited;
}

type Walk = {
  inherited: boolean;
  hidden: boolean;
  path: string[];
  withheld: string[];
};

function projectProperty(
  property: ResolvedProperty,
  walk: Walk,
): ResolvedProperty | null {
  const hidden = walk.hidden || property.classification !== null;
  const on = reportedHere(property, walk.inherited, hidden);
  const inner = property.type === "list" ? property.of : property;
  if (inner.type !== "object") return on ? property : null;
  // Paths left out inside count only when the object itself is kept.
  const below: string[] = [];
  const properties = projectProperties(inner.properties, {
    ...walk,
    inherited: on,
    hidden,
    withheld: below,
  });
  if (!Object.keys(properties).length) return null;
  walk.withheld.push(...below);
  const item = { ...inner, properties };
  return property.type === "list" ? { ...property, of: item } : item;
}

function projectProperties(
  properties: Record<string, ResolvedProperty>,
  walk: Walk,
) {
  const projected: Record<string, ResolvedProperty> = {};
  for (const [name, property] of Object.entries(properties)) {
    const path = [...walk.path, name];
    const kept = projectProperty(property, { ...walk, path });
    if (kept) projected[name] = kept;
    else walk.withheld.push(path.join("."));
  }
  return projected;
}

/** The reporting projection of a resolved shape. */
export function projectShape(shape: ResolvedShape): Projection {
  const withheld: string[] = [];
  const properties = projectProperties(shape.properties, {
    inherited: false,
    hidden: false,
    path: [],
    withheld,
  });
  const projected = { for: null, properties };
  // A set: sorted, so the order properties are written in never changes a digest.
  withheld.sort();
  return {
    shape: projected,
    withheld,
    digest: contractDigest("projection", { shape: projected, withheld }),
  };
}

/** Values reach here after full validation, so each has its property's type. */
function pick(property: ResolvedProperty, value: unknown): unknown {
  if (property.type === "object")
    return pickObject(property.properties, value as Record<string, unknown>);
  if (property.type === "list")
    return (value as unknown[]).map((item) => pick(property.of, item));
  return value;
}

function pickObject(
  properties: Record<string, ResolvedProperty>,
  value: Record<string, unknown>,
) {
  const kept: Record<string, unknown> = {};
  for (const [name, property] of Object.entries(properties))
    if (Object.hasOwn(value, name) && value[name] !== undefined)
      kept[name] = pick(property, value[name]);
  return kept;
}

/**
 * The projected value of a full value that passed full validation: only what
 * the projection keeps. A required string left out by privacy is not an
 * error here, and the projected value still validates against `shape`.
 */
export function projectValue(
  projection: Projection,
  value: Record<string, unknown>,
) {
  return pickObject(projection.shape.properties, value);
}
