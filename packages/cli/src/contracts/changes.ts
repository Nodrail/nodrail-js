// What a change to the declared contracts does (preview), for the person
// about to lock it: breaking changes, where a value that was valid may now
// be refused; disclosure changes, where a field newly leaves the machine; and
// the rest. The lock keeps the contracts last reviewed, resolved, so the
// next change is compared with what was reviewed rather than guessed.
import {
  lockSection,
  type CompiledContracts,
  type ResolvedProperty,
  type ResolvedShape,
} from "./engine.ts";
import { reportedPaths, unreportedNotes } from "./paths.ts";

/** The contracts as the lock keeps them, beside the engine's digests. */
export type ContractsBaseline = {
  bindings: Record<
    string,
    { surface: string; shape: string | null; digest: string }
  >;
  agents: Record<
    string,
    { receipt: string | null; implicit: boolean; brief: string | null }
  >;
  shapes: Record<string, ResolvedShape>;
};

/** The lock's two contract sections: the engine's digests, and the review baseline. */
export function lockedContracts(contracts: CompiledContracts) {
  const baseline: ContractsBaseline = {
    bindings: Object.fromEntries(
      contracts.bindings.map((b) => [
        b.name,
        { surface: b.surface, shape: b.shape, digest: b.digest },
      ]),
    ),
    agents: contracts.agents,
    shapes: Object.fromEntries(
      Object.entries(contracts.shapes)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([name, compiled]) => [name, compiled.shape]),
    ),
  };
  return { contracts: lockSection(contracts), contractsBaseline: baseline };
}

export type ChangeKind = "breaking" | "disclosure" | "compatible" | "unknown";
export type ContractChange = {
  kind: ChangeKind;
  subject: string;
  what: string;
};

type Sink = (kind: ChangeKind, what: string) => void;

const shown = (path: string[]) => path.join(".");

const narrowerMin = <T extends number | string>(a: T | null, b: T | null) =>
  b !== null && (a === null || b > a);
const narrowerMax = <T extends number | string>(a: T | null, b: T | null) =>
  b !== null && (a === null || b < a);

/** Bounds: tighter is breaking, looser compatible. */
function compareBounds<T extends number | string>(
  path: string[],
  before: { min: T | null; max: T | null },
  after: { min: T | null; max: T | null },
  report: Sink,
) {
  if (before.min === after.min && before.max === after.max) return;
  const narrower =
    narrowerMin(before.min, after.min) || narrowerMax(before.max, after.max);
  report(
    narrower ? "breaking" : "compatible",
    `${shown(path)}: bounds ${narrower ? "narrowed" : "widened"}`,
  );
}

function compareProperty(
  path: string[],
  before: ResolvedProperty,
  after: ResolvedProperty,
  report: Sink,
) {
  if (before.type !== after.type)
    return report(
      "breaking",
      `${shown(path)}: type changed from ${before.type} to ${after.type}`,
    );
  if (before.optional !== after.optional)
    report(
      after.optional ? "compatible" : "breaking",
      `${shown(path)}: now ${after.optional ? "optional" : "required"}`,
    );
  if (before.role !== after.role)
    report(
      "unknown",
      `${shown(path)}: role changed from ${before.role ?? "none"} to ${after.role ?? "none"}`,
    );
  if (before.for !== after.for)
    report("compatible", `${shown(path)}: its instructions (for) changed`);
  compareTyped(path, before, after, report);
}

function compareValues(
  path: string[],
  was: string[],
  now: string[],
  report: Sink,
) {
  const gone = was.filter((v) => !now.includes(v));
  const added = now.filter((v) => !was.includes(v));
  if (gone.length > 0)
    report("breaking", `${shown(path)}: no longer accepts ${gone.join(", ")}`);
  if (added.length > 0)
    report("compatible", `${shown(path)}: also accepts ${added.join(", ")}`);
}

/** What only a property of this type can change: values, units, bounds, items. */
function compareTyped(
  path: string[],
  before: ResolvedProperty,
  after: ResolvedProperty,
  report: Sink,
) {
  switch (after.type) {
    case "enum":
      return compareValues(
        path,
        (before as typeof after).values,
        after.values,
        report,
      );
    case "integer":
    case "number": {
      const was = before as typeof after;
      if (was.unit !== after.unit)
        report(
          "breaking",
          `${shown(path)}: unit changed from ${was.unit ?? "none"} to ${after.unit ?? "none"}`,
        );
      return compareBounds(path, was, after, report);
    }
    case "string":
      return compareBounds(path, before as typeof after, after, report);
    case "date":
      return compareBounds(path, before as typeof after, after, report);
    case "list":
      compareBounds(path, before as typeof after, after, report);
      return compareProperty(
        [...path.slice(0, -1), `${path.at(-1)!}[]`],
        (before as typeof after).of,
        after.of,
        report,
      );
    case "object":
      return compareProperties(
        path,
        (before as typeof after).properties,
        after.properties,
        report,
      );
    default:
      return;
  }
}

function compareProperties(
  at: string[],
  before: Record<string, ResolvedProperty>,
  after: Record<string, ResolvedProperty>,
  report: Sink,
) {
  for (const [name, was] of Object.entries(before)) {
    const now = after[name];
    const path = [...at, name];
    if (now === undefined)
      report(
        "breaking",
        `${shown(path)}: removed; a value that has it is now refused`,
      );
    else compareProperty(path, was, now, report);
  }
  for (const [name, now] of Object.entries(after))
    if (!Object.hasOwn(before, name))
      report(
        now.optional ? "compatible" : "breaking",
        `${shown([...at, name])}: new and ${now.optional ? "optional" : "required"}`,
      );
}

/** Every field the projection reports, leaves only, list items marked. */
const reportedLeaves = (shape: ResolvedShape | null) =>
  new Set(
    shape
      ? reportedPaths(shape).flatMap((each) =>
          each.leaf ? [each.itemPath] : [],
        )
      : [],
  );

/** Fields newly reported, and fields no longer reported. */
function compareReporting(
  before: ResolvedShape | null,
  after: ResolvedShape | null,
  report: Sink,
) {
  const was = reportedLeaves(before);
  const now = reportedLeaves(after);
  for (const path of now)
    if (!was.has(path))
      report("disclosure", `${path}: now reported, so it leaves this machine`);
  for (const path of was)
    if (!now.has(path)) report("compatible", `${path}: no longer reported`);
}

function compareShapes(
  before: ResolvedShape,
  after: ResolvedShape,
  report: Sink,
) {
  if (before.for !== after.for)
    report("compatible", "its instructions (for) changed");
  compareProperties([], before.properties, after.properties, report);
  compareReporting(before, after, report);
}

const ORDER: ChangeKind[] = ["breaking", "disclosure", "unknown", "compatible"];

type Side = ContractsBaseline | null;

const shapeOf = (side: Side, binding: string): ResolvedShape | null => {
  const name = side?.bindings[binding]?.shape;
  return name ? (side!.shapes[name] ?? null) : null;
};

const keys = (a: object | undefined, b: object | undefined) =>
  [...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])].sort();

/** What adding or removing a connection's checked slot does to its calls. */
const CHECKED: Record<string, { added: string; removed: string }> = {
  S03: {
    added: "calls whose arguments don't match are refused before the provider",
    removed:
      "its arguments are no longer checked; review it as a policy change",
  },
  S04: {
    added: "results that don't match are withheld from the agent",
    removed:
      "its results reach the agent unchecked; review it as a policy change",
  },
};

type Baselined = NonNullable<Side>["bindings"][string];

/** A binding that is new or gone; false when it is in both. */
function addedOrRemoved(
  was: Baselined | undefined,
  is: Baselined | undefined,
  report: Sink,
  reporting: () => void,
) {
  const connection = CHECKED[(is ?? was)!.surface];
  if (!was) {
    // A new check on a connection refuses what used to pass; a receipt or a
    // brief is new to its agent, which the agent's own line says.
    if (connection)
      report("breaking", `new, with shape ${is!.shape}: ${connection.added}`);
    else report("compatible", `new, with shape ${is!.shape ?? "none"}`);
    reporting();
    return true;
  }
  if (is) return false;
  if (connection) report("unknown", `removed: ${connection.removed}`);
  else report("breaking", "removed; whatever reads it no longer can");
  return true;
}

/** One binding's change, when its digest moved. */
function compareBinding(before: Side, now: Side, name: string, report: Sink) {
  const was = before?.bindings[name];
  const is = now?.bindings[name];
  if (was?.digest === is?.digest) return;
  const reporting = () => compareReporting(null, shapeOf(now, name), report);
  if (addedOrRemoved(was, is, report, reporting) || !was || !is) return;
  let said = false;
  const counted: Sink = (kind, what) => {
    said = true;
    report(kind, what);
  };
  if (was.shape !== is.shape)
    counted("compatible", `now shape ${is.shape} (was ${was.shape})`);
  const a = shapeOf(before, name);
  const b = shapeOf(now, name);
  if (a && b) compareShapes(a, b, counted);
  if (!said)
    report(
      "unknown",
      "changed in a way not classified here (its format, header, reporting or classification)",
    );
}

/** An agent's receipt or brief changed: what it must produce, or is given. */
function compareAgent(before: Side, now: Side, agent: string, report: Sink) {
  const was = before?.agents[agent];
  if (was === undefined) return;
  const is = now?.agents[agent];
  for (const [slot, verb] of [
    ["receipt", "ends with"],
    ["brief", "takes"],
  ] as const) {
    const then = was[slot];
    const next = is?.[slot] ?? null;
    if (then !== next)
      report(
        "breaking",
        `now ${verb} ${next ? `${slot} ${next}` : `no declared ${slot}`} (was ${then ?? "none"})`,
      );
  }
}

/**
 * What changed between the contracts last locked and these, each change
 * classified. Null before is a first lock: every binding is new.
 */
export function contractChanges(
  before: Side,
  after: CompiledContracts | null,
): ContractChange[] {
  const now = after ? lockedContracts(after).contractsBaseline : null;
  const changes: ContractChange[] = [];
  const sink =
    (subject: string): Sink =>
    (kind, what) =>
      changes.push({ kind, subject, what });
  for (const name of keys(before?.bindings, now?.bindings))
    compareBinding(before, now, name, sink(name));
  for (const agent of keys(before?.agents, now?.agents))
    compareAgent(before, now, agent, sink(`agent ${agent}`));
  return changes.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
}

/** The changes as lines for a person, or none when nothing changed. */
export function changeLines(changes: ContractChange[], against: string) {
  if (changes.length === 0) return [];
  const width = Math.max(...changes.map((c) => c.subject.length));
  return [
    `Contracts, compared with ${against}:`,
    ...changes.map(
      (c) => `  ${c.kind.padEnd(10)}  ${c.subject.padEnd(width)}  ${c.what}`,
    ),
  ];
}

/**
 * Each agent's declared receipt and brief: what the agent files say, and
 * where the hook checks them. A receipt picked by the agent's name is shown
 * as such. `items` are the rule files' items, for the `where` Cloud can't read.
 */
export function bindingNotes({
  contracts,
  items,
}: {
  contracts: CompiledContracts | null;
  items: unknown[];
}) {
  if (contracts === null) return [];
  const agents = Object.entries(contracts.agents).flatMap(([name, agent]) => {
    const parts = [
      ...(agent.receipt
        ? [`receipt ${agent.receipt}${agent.implicit ? " (by its name)" : ""}`]
        : []),
      ...(agent.brief ? [`brief ${agent.brief}`] : []),
    ];
    return parts.length > 0 ? [`  ${name}: ${parts.join(", ")}`] : [];
  });
  const connections = contracts.bindings
    .filter((b) => b.surface === "S03" || b.surface === "S04")
    .map((b) => `  ${b.name}: shape ${b.shape}`);
  return [
    `Contracts, ${contracts.digest.slice(0, 19)}: each receipt is described in its agent's file, and the hook reads it against its contract when the agent stops (Claude Code, Copilot; on Codex nothing captures it, so a gate waiting for it stays closed). Each brief is described in the files of the agents that start it, and the hook reads it before the agent starts (Claude Code, Copilot; Codex doesn't show the hook the prompt, so starting an agent with a brief is denied there).`,
    ...agents,
    ...(connections.length > 0
      ? [
          "Connection contracts (preview): the hook checks each call's arguments before the rules judge it, and the connection Nodrail runs checks them again before the provider and the result before the agent, recording each call.",
          ...connections,
        ]
      : []),
    ...unreportedNotes(contracts, items),
  ];
}
