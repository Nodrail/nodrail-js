// Rendering a version 3 document's contracts back to a rule file's
// `contracts` entry and requirement fields, so exporting never drops a
// receipt, brief or input contract, or a `where`. The resolved shape is
// written out in full, so it recompiles to the same contract digest.
import type { Requirement } from "./policies.ts";
import type { BriefContract } from "./shapes/brief.ts";
import type { InputContract } from "./shapes/inputs.ts";
import type { ReceiptContract } from "./shapes/receipt.ts";
import type { CompiledCondition, ResolvedProperty } from "./shapes/types.ts";

type Decl = Record<string, unknown>;

const set = (entries: [string, unknown][]) =>
  Object.fromEntries(entries.filter(([, value]) => value !== null));

function typeDecl(property: ResolvedProperty): Decl {
  switch (property.type) {
    case "enum":
      return { values: property.values };
    case "object":
      return { properties: shapeDecl(property.properties) };
    case "list":
      return {
        type: "list",
        of: propertyDecl(property.of),
        min: property.min,
        max: property.max,
      };
    case "integer":
    case "number":
      return set([
        ["type", property.type],
        ["min", property.min],
        ["max", property.max],
        ["unit", property.unit],
      ]);
    case "date":
      return set([
        ["type", "date"],
        ["min", property.min],
        ["max", property.max],
      ]);
    case "string":
      return { type: "string", min: property.min, max: property.max };
    default:
      return { type: property.type };
  }
}

function propertyDecl(property: ResolvedProperty): Decl {
  return {
    ...typeDecl(property),
    ...set([
      ["optional", property.optional ? true : null],
      ["for", property.for],
      ["report", property.report],
      ["classification", property.classification],
      ["role", property.role],
    ]),
  };
}

function shapeDecl(properties: Record<string, ResolvedProperty>) {
  return Object.fromEntries(
    Object.entries(properties).map(([name, property]) => [
      name,
      propertyDecl(property),
    ]),
  );
}

type Resolved = ReceiptContract["shape"];

const resolvedDecl = (shape: Resolved) => ({
  ...(shape.for === null ? {} : { for: shape.for }),
  properties: shapeDecl(shape.properties),
});

/**
 * Shapes by name, as the rule file declares them. A name already holding
 * another shape gets a numbered one, so two contracts never share a name
 * with different definitions.
 */
function shapeNamer(shapes: Record<string, Decl>) {
  return (wanted: string, shape: Resolved) => {
    const decl = resolvedDecl(shape);
    const same = JSON.stringify(decl);
    const base = wanted.slice(0, 58);
    for (let index = 1; ; index += 1) {
      const name = index === 1 ? base : `${base}-${index}`;
      if (!shapes[name]) {
        shapes[name] = decl;
        return name;
      }
      if (JSON.stringify(shapes[name]) === same) return name;
    }
  };
}

/** A shape name for an operation's input: `<tool>-<operation>-input`. */
const inputShapeName = (key: string) =>
  `${key.replace(/[^a-z0-9]+/g, "-").replace(/^[^a-z]+/, "")}-input`.replace(
    /^-/,
    "x-",
  );

export type RenderedContracts = {
  receipts: Record<string, ReceiptContract>;
  briefs?: Record<string, BriefContract>;
  inputs?: Record<string, InputContract>;
};

/**
 * The `contracts` entry that declares these receipts, briefs and inputs:
 * each agent picking its receipt and brief, each operation its input.
 */
export function renderContracts({
  receipts,
  briefs = {},
  inputs = {},
}: RenderedContracts) {
  const shapes: Record<string, Decl> = {};
  const named = shapeNamer(shapes);
  const declared: Record<string, Decl> = {};
  const agents: Record<string, { receipt?: string; brief?: unknown }> = {};
  // A brief contract is named by its shape, so its shape keeps that name;
  // two briefs with one shape name share one definition.
  for (const brief of Object.values(briefs))
    shapes[brief.name] = resolvedDecl(brief.shape);
  for (const [agent, receipt] of Object.entries(receipts)) {
    // A receipt's shape takes the receipt's name, unless a brief has it.
    const shape = named(receipt.name, receipt.shape);
    declared[receipt.name] = {
      shape,
      format: receipt.format,
      ...(receipt.header ? { header: receipt.header } : {}),
    };
    agents[agent] = { receipt: receipt.name };
  }
  for (const [agent, brief] of Object.entries(briefs)) {
    const shape = brief.name;
    agents[agent] = {
      ...agents[agent],
      brief:
        brief.format === "header"
          ? {
              shape,
              format: "header",
              ...(brief.aliases && Object.keys(brief.aliases).length
                ? { header: { aliases: brief.aliases } }
                : {}),
            }
          : shape,
    };
  }
  const connections: Record<
    string,
    { operations: Record<string, { input: string }> }
  > = {};
  for (const [key, input] of Object.entries(inputs)) {
    const dot = key.indexOf(".");
    const tool = key.slice(0, dot);
    const operation = key.slice(dot + 1);
    connections[tool] ??= { operations: {} };
    connections[tool].operations[operation] = {
      input: named(inputShapeName(key), input.shape),
    };
  }
  return {
    contracts: {
      shapes,
      receipts: declared,
      agents,
      ...(Object.keys(connections).length ? { connections } : {}),
    },
  };
}

function conditionDecl(condition: CompiledCondition) {
  if (condition.op === "eq") return condition.value;
  if (condition.op === "in") return { in: condition.values };
  return set([
    ["min", condition.min],
    ["max", condition.max],
  ]);
}

/** Compiled conditions as a rule file's `where`, or nothing. */
export function renderWhere(where: readonly CompiledCondition[] | undefined) {
  return where?.length
    ? {
        where: Object.fromEntries(
          where.map((condition) => [
            condition.path.join("."),
            conditionDecl(condition),
          ]),
        ),
      }
    : {};
}

/** A requirement's version 4 fields, as a rule file writes them. */
export function renderRequirementContract({ where, subject }: Requirement) {
  return {
    ...renderWhere(where),
    ...(subject ? { subject } : {}),
  };
}
