// What an edit to a policy does to permissions, for a reviewer to read before
// it is committed. Pure and free of Node APIs, so it runs in a browser too.
import {
  entryAspects,
  gained,
  lost,
  requirementAspects,
  describeRequirement,
  type Aspect,
  type PermissionImpact,
} from "./permission-aspects.ts";
import {
  budgetAspects,
  describeBudget,
  describeEvidenceNeed,
  evidenceAspects,
  type AnyBudget,
} from "./permission-budgets.ts";
import { evidenceOf, limitsOf } from "./policies.ts";
import {
  canonical,
  describeCondition,
  describeScope,
  coversAll,
  mayOverlap,
  nameRelation,
  scopeRelation,
} from "./permission-scope.ts";
import type { PolicyDocument, PolicyGate, PolicyRule } from "./policies.ts";

export type { PermissionImpact } from "./permission-aspects.ts";

export type PermissionChange = {
  impact: PermissionImpact;
  /** Removes a deny or something a gate waited for: read these first. */
  warning: boolean;
  entry: "rule" | "gate" | "budget";
  id: string;
  /** The id it had before, when only its id and name changed. */
  renamedFrom: string | null;
  name: string;
  /** Null: every agent. */
  agent: string | null;
  installation: string | null;
  /** `tool.operation`; null for a budget, which covers every operation. */
  operation: string | null;
  /** The resource scope, or for a budget what it counts. */
  resource: string;
  summary: string;
  /** Conditions added or dropped, or both versions when it needs review. */
  details: string[];
};

type Item =
  | { entry: "rule"; value: PolicyRule }
  | { entry: "gate"; value: PolicyGate }
  | { entry: "budget"; value: AnyBudget };

function itemsOf(document: PolicyDocument | null): Item[] {
  if (!document) return [];
  const rules = document.rules.map(
    (value) => ({ entry: "rule", value }) as const,
  );
  if (document.version === 1) return rules;
  return [
    ...rules,
    ...document.gates.map((value) => ({ entry: "gate", value }) as const),
    ...[...document.budgets, ...limitsOf(document)].map(
      (value) => ({ entry: "budget", value }) as const,
    ),
  ];
}

/** Several aspects agree, or the change is mixed; review trumps both. */
function overall(aspects: Aspect[]): PermissionImpact {
  const impacts = [...new Set(aspects.flatMap(({ impact }) => impact ?? []))];
  if (impacts.includes("needs_review")) return "needs_review";
  return impacts.length === 1 && impacts[0] ? impacts[0] : "changed";
}

function place(item: Item) {
  if (item.entry === "budget")
    return {
      agent: item.value.agent,
      installation: null,
      operation: null,
      resource:
        "metric" in item.value
          ? `${item.value.metric} per ${item.value.per}`
          : describeBudget(item.value),
    };
  const { agentKey, installationName, toolKey, operationKey, resource } =
    item.value;
  return {
    agent: agentKey,
    installation: installationName,
    operation: `${toolKey}.${operationKey}`,
    resource: describeScope(resource),
  };
}

function change(
  item: Item,
  aspects: Aspect[],
  renamedFrom: string | null = null,
) {
  return {
    impact: overall(aspects),
    warning: aspects.some(({ warning }) => warning === true),
    entry: item.entry,
    id: item.value.id,
    renamedFrom,
    name: item.value.name,
    ...place(item),
    summary: aspects.map(({ text }) => text).join("; "),
    details: aspects.flatMap(({ details }) => details ?? []),
  } satisfies PermissionChange;
}

const allows = (items: Item[], rule: PolicyRule) =>
  items.some(
    (other) =>
      other.entry === "rule" &&
      other.value.effect === "allow" &&
      mayOverlap(other.value, rule),
  );

const coveredByAllow = (items: Item[], rule: PolicyRule) =>
  items.some(
    (other) =>
      other.entry === "rule" &&
      other.value.effect === "allow" &&
      coversAll(other.value, rule),
  );

function ruleDetails(rule: PolicyRule | PolicyGate) {
  return [
    ...rule.conditions.map((item) => `where ${describeCondition(item)}`),
    ...(rule.expiresAt ? [`expires ${rule.expiresAt}`] : []),
  ];
}

/**
 * A new rule. A review can block an allowed action or open a blocked one, so
 * where an allow may already apply it is only "changed".
 */
function added(item: Item, before: Item[], how = "added"): PermissionChange {
  if (item.entry === "budget")
    return change(item, [
      {
        impact: "tightened",
        text: `${how}: ${item.value.effect.replace("_", " ")} over ${describeBudget(item.value)}`,
      },
    ]);
  const details = ruleDetails(item.value);
  if (item.entry === "gate") {
    const needs = [
      ...item.value.requires.map(describeRequirement),
      ...evidenceOf(item.value).map(describeEvidenceNeed),
    ].join("; ");
    const text = `${how}: ${item.value.effect.replace("_", " ")} until ${needs}`;
    return change(item, [{ impact: "tightened", text, details }]);
  }
  const { effect } = item.value;
  const text = `${how} (${effect.replace("_", " ")})`;
  if (effect === "allow")
    return change(item, [{ impact: "granted", text, details }]);
  if (effect === "deny") return change(item, [gained(effect, text, details)]);
  const impact = allows(before, item.value) ? "changed" : "granted";
  return change(item, [{ impact, text, details }]);
}

/** A rule gone. Without a review, what it covered falls to any allow or to the default. */
function removed(item: Item, after: Item[], how = "removed"): PermissionChange {
  if (item.entry === "budget")
    return change(item, [
      {
        impact: "loosened",
        warning: true,
        text: `${how}: ${describeBudget(item.value)}`,
      },
    ]);
  const details = ruleDetails(item.value);
  if (item.entry === "gate")
    return change(item, [
      { impact: "loosened", warning: true, text: how, details },
    ]);
  const { effect } = item.value;
  const text = `${how} (${effect.replace("_", " ")})`;
  if (effect === "allow")
    return change(item, [{ impact: "revoked", text, details }]);
  if (effect === "deny") return change(item, [lost(effect, text, details)]);
  // What the review held falls to an allow where one covers it, else to the
  // default block: looser only if an allow covers all of it.
  const impact = coveredByAllow(after, item.value)
    ? "loosened"
    : allows(after, item.value)
      ? "changed"
      : "revoked";
  return change(item, [{ impact, text, details }]);
}

/**
 * Whether two versions of a rule or gate can be compared at all. One moved to
 * another operation, agent or unrelated resource is gone from one place and
 * new in another, so it is shown as both.
 */
function comparable(
  before: PolicyRule | PolicyGate,
  after: PolicyRule | PolicyGate,
) {
  return (
    before.toolKey === after.toolKey &&
    before.operationKey === after.operationKey &&
    nameRelation(before.agentKey, after.agentKey) !== "unknown" &&
    nameRelation(before.installationName, after.installationName) !==
      "unknown" &&
    scopeRelation(before.resource, after.resource) !== "unknown"
  );
}

type Pair = { before: Item; after: Item };
type Sides = { before: Item[]; after: Item[] };

/** What changed in an entry kept under its id, or null when it can't be compared. */
function aspectsOf(before: Item, after: Item): Aspect[] | null {
  if (before.entry === "budget" || after.entry === "budget")
    return before.entry === "budget" && after.entry === "budget"
      ? budgetAspects(before.value, after.value)
      : null;
  if (!comparable(before.value, after.value)) return null;
  const aspects = entryAspects(
    before.value,
    after.value,
    after.entry === "gate",
  );
  if (before.entry === "gate" && after.entry === "gate")
    aspects.push(
      ...requirementAspects(before.value.requires, after.value.requires),
      ...evidenceAspects(evidenceOf(before.value), evidenceOf(after.value)),
    );
  return aspects;
}

function edited({ before, after }: Pair, sides: Sides): PermissionChange[] {
  if (canonical(before.value) === canonical(after.value)) return [];
  const aspects = aspectsOf(before, after);
  if (!aspects)
    return [
      removed(before, sides.after, "moved away"),
      added(after, sides.before, "moved here"),
    ];
  // Conditions or requirements only reordered: nothing to show.
  return aspects.length ? [change(after, aspects)] : [];
}

const keyOf = (item: Item) => `${item.entry}:${item.value.id}`;

/** Everything but the id and name, so a renamed entry is found again. */
const signature = ({ entry, value: { id: _id, name: _name, ...rest } }: Item) =>
  canonical({ entry, rest });

/**
 * An entry renamed without an id gets a new id. One that is otherwise
 * identical is the same entry, not a revoke and a grant.
 */
function renames(gone: Item[], fresh: Item[]) {
  const waiting = new Map<string, Item[]>();
  for (const item of gone)
    waiting.set(signature(item), [
      ...(waiting.get(signature(item)) ?? []),
      item,
    ]);
  const pairs: Pair[] = [];
  for (const item of fresh) {
    const match = waiting.get(signature(item))?.shift();
    if (match) pairs.push({ before: match, after: item });
  }
  return pairs;
}

const byId = (a: Item, b: Item) => (keyOf(a) < keyOf(b) ? -1 : 1);

/**
 * How permissions change from one compiled policy to the next, grouped and
 * ordered by agent, operation and resource. Null before means a first
 * install, so everything is new.
 */
export function permissionChanges(
  before: PolicyDocument | null,
  after: PolicyDocument,
): PermissionChange[] {
  const sides = {
    before: itemsOf(before).sort(byId),
    after: itemsOf(after).sort(byId),
  };
  const was = new Map(sides.before.map((item) => [keyOf(item), item]));
  const kept = new Set(sides.after.map(keyOf).filter((key) => was.has(key)));
  const renamed = renames(
    sides.before.filter((item) => !kept.has(keyOf(item))),
    sides.after.filter((item) => !kept.has(keyOf(item))),
  );
  const paired = new Set(
    renamed.flatMap(({ before, after }) => [before, after]),
  );
  const changes = [
    ...sides.after.flatMap((item) => {
      const old = was.get(keyOf(item));
      return old ? edited({ before: old, after: item }, sides) : [];
    }),
    ...renamed.map(({ before, after }) =>
      change(
        after,
        [
          {
            impact: "changed",
            text: `renamed from ${before.value.id} "${before.value.name}"`,
          },
        ],
        before.value.id,
      ),
    ),
    ...sides.after
      .filter((item) => !kept.has(keyOf(item)) && !paired.has(item))
      .map((item) => added(item, sides.before)),
    ...sides.before
      .filter((item) => !kept.has(keyOf(item)) && !paired.has(item))
      .map((item) => removed(item, sides.after)),
  ];
  return sortChanges(changes);
}

const order = { rule: 0, gate: 1, budget: 2 } as const;

/** Plain code unit order, never the locale's, so every machine agrees. */
function sortKey(change: PermissionChange) {
  return [
    change.agent ?? "",
    change.installation ?? "",
    change.operation === null ? "1" : `0${change.operation}`,
    change.resource,
    String(order[change.entry]),
    change.id,
    change.summary,
  ];
}

export function sortChanges(changes: PermissionChange[]) {
  const keyed = changes.map((item) => ({ item, key: sortKey(item) }));
  keyed.sort((a, b) => {
    const index = a.key.findIndex((part, at) => part !== b.key[at]);
    if (index < 0) return 0;
    return (a.key[index] ?? "") < (b.key[index] ?? "") ? -1 : 1;
  });
  return keyed.map(({ item }) => item);
}
