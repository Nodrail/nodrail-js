// How the set of actions an entry covers changed between two versions of a
// policy. Only relations that hold for every action are claimed; anything
// else is "unknown", so a reviewer is never told a change is safe on a guess.
import canonicalize from "canonicalize";
import type {
  Condition,
  PolicyGate,
  PolicyRule,
  ResourceScope,
} from "./policies.ts";

/** How the actions the after version covers compare with the before version. */
export type Relation = "same" | "wider" | "narrower" | "unknown";

/** A stable text form, so equal entries compare equal on any machine. */
export const canonical = (value: unknown) => canonicalize(value) ?? "null";

/** Both relations at once: they agree, or one of them changed nothing. */
export function combineRelations(...relations: Relation[]): Relation {
  const moved = relations.filter((relation) => relation !== "same");
  const [first = "same"] = moved;
  return moved.every((relation) => relation === first) ? first : "unknown";
}

/** Whether every resource the inner scope matches is matched by the outer one. */
function covers(outer: ResourceScope, inner: ResourceScope) {
  if (outer.match === "any") return true;
  if (inner.match === "any") return false;
  if (outer.match === "exact")
    return inner.match === "exact" && inner.value === outer.value;
  return (inner.value ?? "").startsWith(outer.value ?? "\u0000");
}

/** Resource scopes of different kinds never match the same action. */
export function scopeRelation(
  before: ResourceScope,
  after: ResourceScope,
): Relation {
  if (canonical(before) === canonical(after)) return "same";
  if (before.kind !== after.kind) return "unknown";
  if (covers(after, before)) return "wider";
  if (covers(before, after)) return "narrower";
  return "unknown";
}

/** Null means everyone, so dropping a name widens and adding one narrows. */
export function nameRelation(
  before: string | null,
  after: string | null,
): Relation {
  if (before === after) return "same";
  if (after === null) return "wider";
  if (before === null) return "narrower";
  return "unknown";
}

/**
 * Conditions all have to hold, so more of them match fewer actions. Two lists
 * where neither contains the other could go either way: that is "unknown".
 */
export function setRelation(before: unknown[], after: unknown[]): Relation {
  const was = new Set(before.map(canonical));
  const now = new Set(after.map(canonical));
  const keepsAll = [...was].every((item) => now.has(item));
  const addsNone = [...now].every((item) => was.has(item));
  if (keepsAll && addsNone) return "same";
  if (keepsAll) return "narrower";
  if (addsNone) return "wider";
  return "unknown";
}

/** A list of accepted values: more of them is wider, the opposite of conditions. */
export function acceptedRelation(
  before: unknown[],
  after: unknown[],
): Relation {
  const relation = setRelation(before, after);
  if (relation === "narrower") return "wider";
  if (relation === "wider") return "narrower";
  return relation;
}

const value = (scope: ResourceScope) => JSON.stringify(scope.value ?? "");

export function describeScope(scope: ResourceScope) {
  return scope.match === "any"
    ? `${scope.kind} (any)`
    : `${scope.kind} ${scope.match} ${value(scope)}`;
}

export function describeCondition({ field, op, value }: Condition) {
  return `${field} ${op} ${JSON.stringify(value)}`;
}

/** What an entry matches, conditions included, as one line. */
export function describeMatch(entry: PolicyRule | PolicyGate) {
  const where = entry.conditions.map(describeCondition).join(" and ");
  return where
    ? `${describeScope(entry.resource)} where ${where}`
    : describeScope(entry.resource);
}
