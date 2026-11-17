// What one edited rule or gate does to permissions, one aspect at a time:
// its effect, what it matches, when it expires, what a gate waits for.
import type {
  Effect,
  PolicyGate,
  PolicyRule,
  Requirement,
} from "./policies.ts";
import {
  acceptedRelation,
  combineRelations,
  describeCondition,
  describeMatch,
  describeScope,
  nameRelation,
  scopeRelation,
  setRelation,
  type Relation,
} from "./permission-scope.ts";

export type PermissionImpact =
  "granted" | "revoked" | "tightened" | "loosened" | "changed" | "needs_review";

/** One part of a change. A null impact (a new name, say) changes no decision. */
export type Aspect = {
  impact: PermissionImpact | null;
  warning?: boolean;
  text: string;
  details?: string[];
};

type Entry = PolicyRule | PolicyGate;

/**
 * An entry now covers actions it did not. Deny always wins, so more deny is
 * tighter; a review can turn an allow into a question or a block into one.
 */
export function gained(effect: Effect, text: string, details?: string[]) {
  const impact = { allow: "loosened", deny: "tightened" } as const;
  return { impact: impact[effect as "allow"] ?? "changed", text, details };
}

/** An entry stops covering actions. Losing a deny is the dangerous one. */
export function lost(effect: Effect, text: string, details?: string[]): Aspect {
  if (effect === "deny")
    return { impact: "loosened", warning: true, text, details };
  return {
    impact: effect === "allow" ? "tightened" : "changed",
    text,
    details,
  };
}

const strength = { deny: 0, require_approval: 1, allow: 2 } as const;
const effectName = (effect: Effect) => effect.replace("_", " ");

/** The same actions decided more or less strictly than before. */
function effectAspect(before: Effect, after: Effect, gate: boolean): Aspect[] {
  if (before === after) return [];
  const text = `${gate ? "otherwise " : "effect "}${effectName(before)} → ${effectName(after)}`;
  if (strength[after] < strength[before])
    return [{ impact: "tightened", text }];
  // A deny or a gate that now only asks lets through what a person allows.
  return [{ impact: "loosened", warning: before === "deny", text }];
}

const who = (name: string | null, everyone: string) => name ?? everyone;

/** The parts of what an entry matches that changed, in words. */
function matchTexts(before: Entry, after: Entry) {
  const texts: string[] = [];
  if (before.agentKey !== after.agentKey)
    texts.push(
      `agent ${who(before.agentKey, "all")} → ${who(after.agentKey, "all")}`,
    );
  if (before.installationName !== after.installationName)
    texts.push(
      `installation ${who(before.installationName, "any")} → ${who(after.installationName, "any")}`,
    );
  if (scopeRelation(before.resource, after.resource) !== "same")
    texts.push(
      `resource ${describeScope(before.resource)} → ${describeScope(after.resource)}`,
    );
  return texts;
}

function conditionDetails(before: Entry, after: Entry) {
  const was = before.conditions.map(describeCondition);
  const now = after.conditions.map(describeCondition);
  return [
    ...was.filter((item) => !now.includes(item)).map((item) => `- ${item}`),
    ...now.filter((item) => !was.includes(item)).map((item) => `+ ${item}`),
  ];
}

/** How the set of actions an entry covers changed, agent to conditions. */
export function matchRelation(before: Entry, after: Entry): Relation {
  return combineRelations(
    nameRelation(before.agentKey, after.agentKey),
    nameRelation(before.installationName, after.installationName),
    scopeRelation(before.resource, after.resource),
    setRelation(before.conditions, after.conditions),
  );
}

/** A gate holds actions back, so it moves like a deny when it widens or narrows. */
function matchAspect(before: Entry, after: Entry, gate: boolean): Aspect[] {
  const relation = matchRelation(before, after);
  if (relation === "same") return [];
  const conditions = conditionDetails(before, after);
  const texts = matchTexts(before, after);
  if (conditions.length) texts.push("conditions changed");
  const text = texts.join("; ");
  if (relation === "unknown")
    return [
      {
        impact: "needs_review",
        // A deny or a gate that may no longer cover some actions may have
        // let them through: flag it, since nothing proves it didn't.
        warning: gate || before.effect === "deny",
        text,
        details: [
          `before: ${describeMatch(before)}`,
          `after: ${describeMatch(after)}`,
        ],
      },
    ];
  const effect = gate
    ? "deny"
    : relation === "wider"
      ? after.effect
      : before.effect;
  return [(relation === "wider" ? gained : lost)(effect, text, conditions)];
}

const until = (expiresAt: string | null) =>
  expiresAt === null ? Infinity : Date.parse(expiresAt);

/** An entry that lasts longer covers more; one that ends sooner covers less. */
function expiryAspect(before: Entry, after: Entry, gate: boolean): Aspect[] {
  if (before.expiresAt === after.expiresAt) return [];
  const text = `expires ${before.expiresAt ?? "never"} → ${after.expiresAt ?? "never"}`;
  if (!gate && before.effect !== after.effect)
    return [{ impact: "changed", text }];
  const effect = gate ? "deny" : after.effect;
  const longer = until(after.expiresAt) > until(before.expiresAt);
  return [(longer ? gained : lost)(effect, text)];
}

function nameAspect(before: Entry, after: Entry): Aspect[] {
  return before.name === after.name
    ? []
    : [{ impact: null, text: `renamed "${before.name}" → "${after.name}"` }];
}

/** Every aspect of a rule or gate kept under the same id that changed. */
export function entryAspects(before: Entry, after: Entry, gate: boolean) {
  return [
    ...effectAspect(before.effect, after.effect, gate),
    ...matchAspect(before, after, gate),
    ...expiryAspect(before, after, gate),
    ...nameAspect(before, after),
  ];
}

export const describeRequirement = ({ agent, verdicts, since }: Requirement) =>
  `${agent}: ${verdicts.join(" or ")}${since.length ? ` since ${since.join(", ")}` : ""}`;

/**
 * Agents a gate waits for check the work, so their commands don't count as
 * changing it. A new agent there can make the other requirements easier to
 * meet; that only matters when one of them looks for changes (`since`).
 */
function addedRequirement(
  requirement: Requirement,
  after: Requirement[],
): Aspect {
  const text = `requires ${describeRequirement(requirement)}`;
  const checksChanges = after.some(
    (other) => other.agent !== requirement.agent && other.since.length,
  );
  if (!checksChanges) return { impact: "tightened", text };
  return {
    impact: "needs_review",
    text,
    details: [
      `${requirement.agent}'s commands no longer count as changing the work for the other requirements`,
    ],
  };
}

/** One agent's requirement in both versions: which verdicts pass, and since when. */
function editedRequirement(before: Requirement, after: Requirement): Aspect[] {
  // What passes: more verdicts accepted is wider. Any work by a `since` agent
  // resets the requirement, so more of them is narrower.
  const passes = combineRelations(
    acceptedRelation(before.verdicts, after.verdicts),
    setRelation(before.since, after.since),
  );
  if (passes === "same") return [];
  const impact = {
    wider: "loosened",
    narrower: "tightened",
    unknown: "needs_review",
  } as const;
  return [
    {
      impact: impact[passes],
      // More verdicts, fewer resets, or no telling: the gate may hold less.
      warning: passes !== "narrower",
      text: `requirement ${describeRequirement(before)} → ${describeRequirement(after)}`,
    },
  ];
}

/** What changed in what a gate waits for, agent by agent. */
export function requirementAspects(
  before: Requirement[],
  after: Requirement[],
) {
  const agents = [
    ...new Set([...before, ...after].map(({ agent }) => agent)),
  ].sort();
  return agents.flatMap((agent): Aspect[] => {
    const was = before.filter((item) => item.agent === agent);
    const now = after.filter((item) => item.agent === agent);
    if (!now.length)
      return was.map((item) => ({
        impact: "loosened",
        warning: true,
        text: `no longer requires ${describeRequirement(item)}`,
      }));
    if (!was.length) return now.map((item) => addedRequirement(item, after));
    if (was.length === 1 && now.length === 1 && was[0] && now[0])
      return editedRequirement(was[0], now[0]);
    if (setRelation(was, now) === "same") return [];
    return [
      {
        impact: "needs_review",
        warning: true,
        text: `requirements for ${agent} changed`,
        details: [
          `before: ${was.map(describeRequirement).join("; ")}`,
          `after: ${now.map(describeRequirement).join("; ")}`,
        ],
      },
    ];
  });
}
