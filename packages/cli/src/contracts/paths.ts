// The property paths of a resolved shape, in one walk for every reader in
// the CLI: what a projection reports (explain, plan), what a change newly
// discloses (changes), and whether a `where` reads a reported field.
import {
  projectShape,
  type CompiledContracts,
  type ResolvedProperty,
  type ResolvedShape,
} from "./engine.ts";

export type PropertyPath = {
  /** Dotted names from the top: `findings.blocker`. */
  path: string;
  /** The same with each list it goes through marked: `items[].name`. */
  itemPath: string;
  property: ResolvedProperty;
  /** True when it holds a value rather than further properties. */
  leaf: boolean;
};

/** Each property, parents before their children, list items included. */
export function propertyPaths(
  properties: Record<string, ResolvedProperty>,
  at: string[] = [],
  items: string[] = [],
): PropertyPath[] {
  return Object.entries(properties).flatMap(([name, property]) => {
    const inner = property.type === "list" ? property.of : property;
    const path = [...at, name];
    const here: PropertyPath = {
      path: path.join("."),
      itemPath: [...items, name].join("."),
      property,
      leaf: inner.type !== "object",
    };
    if (inner.type !== "object") return [here];
    const marked = [...items, property.type === "list" ? `${name}[]` : name];
    return [here, ...propertyPaths(inner.properties, path, marked)];
  });
}

/** Every path the shape's projection reports: what may leave this machine. */
export const reportedPaths = (shape: ResolvedShape) =>
  propertyPaths(projectShape(shape).shape.properties);

type Item = Record<string, unknown> | undefined;

/** The binding a rule's `where` root reads: its operation's input, or the brief of the agent it names. */
export function bindingOf(root: string | undefined, raw: unknown) {
  if (typeof raw !== "object" || raw === null) return null;
  const item = raw as Record<string, unknown>;
  if (root === "input" && typeof item.tool === "string")
    return `input:${item.tool}.${String(item.operation)}`;
  const resource = item.resource as Item;
  if (root === "brief" && typeof resource?.value === "string")
    return `brief:${resource.value}`;
  return null;
}

/** A rule's or gate's name, as a person finds it in its file. */
export const itemName = (item: Item, at: string) =>
  typeof item?.rule === "string"
    ? `rule "${item.rule}"`
    : typeof item?.gate === "string"
      ? `gate "${item.gate}"`
      : at;

/**
 * Each `where` condition on a brief or an operation input that reads a
 * field the projection doesn't report. Nodrail Cloud evaluates `where` only
 * on reported fields, so there such a condition is never met (fail-closed);
 * the local hook reads the whole value and is unaffected.
 */
export function unreportedConditions(
  contracts: CompiledContracts,
  items: unknown[],
) {
  return contracts.consumers.flatMap(({ consumer, at, conditions }) => {
    if (consumer !== "C02") return [];
    const item = items[Number(at.split(".")[1])] as Item;
    return conditions.flatMap(({ path }) => {
      const [root, ...rest] = path;
      const name = bindingOf(root, item);
      const shape = contracts.bindings.find((b) => b.name === name)?.shape;
      const compiled = shape ? contracts.shapes[shape] : undefined;
      if (!compiled) return [];
      const field = rest.join(".");
      const reported = reportedPaths(compiled.shape).some(
        (each) => each.path === field,
      );
      return reported
        ? []
        : [
            {
              where: itemName(item, at),
              binding: name!,
              path: path.join("."),
              field,
            },
          ];
    });
  });
}

/** Plan's warning for each condition Cloud can't read. */
export function unreportedNotes(
  contracts: CompiledContracts | null,
  items: unknown[],
) {
  const found = contracts ? unreportedConditions(contracts, items) : [];
  if (found.length === 0) return [];
  return [
    "In Nodrail Cloud, a where reads only reported fields: these conditions are never met there (fail-closed). The local hook reads the whole value. Report a field (report: true) only if it may leave this machine.",
    ...found.map(
      (each) =>
        `  ${each.where}: where ${each.path}, but ${each.binding} doesn't report ${each.field}`,
    ),
  ];
}
