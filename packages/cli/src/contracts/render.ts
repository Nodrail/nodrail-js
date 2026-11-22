// The receipt section nodrail writes into a generated agent file (preview):
// what to end with, each property with its `for:` text and allowed values,
// and an example made from the contract that validates against it. The
// agent's own instructions file is never edited; `nodrail contracts render`
// prints the same section for an agent nodrail doesn't set up.
import { Document, isMap, isScalar, Scalar, visit } from "yaml";
import { CliError } from "../io.ts";
import {
  readContractReceipt,
  validateValue,
  type CompiledContracts,
  type ReceiptContract,
  type ResolvedProperty,
  type ResolvedShape,
} from "./engine.ts";

/** The markers around nodrail's section, so a reader can tell it apart. */
export const SECTION_BEGIN = "<!-- nodrail:receipt begin";
export const SECTION_END = "<!-- nodrail:receipt end -->";

const EXAMPLE_TEXT = "example";
const EXAMPLE_DATE = "2026-01-01";

const clamp = (value: number, min: number | null, max: number | null) =>
  Math.min(max ?? Infinity, Math.max(min ?? -Infinity, value));

/** `example`, repeated or cut to a length the bounds allow. */
const sized = (min: number, max: number) => {
  const length = Math.min(max, Math.max(min, EXAMPLE_TEXT.length));
  const times = Math.max(1, Math.ceil(length / EXAMPLE_TEXT.length));
  return EXAMPLE_TEXT.repeat(times).slice(0, length);
};

/**
 * A value of the property that its contract accepts: the first allowed
 * value, the bound nearest zero, `example` cut to fit, one item per list.
 */
export function exampleOf(property: ResolvedProperty): unknown {
  switch (property.type) {
    case "string":
      return sized(property.min, property.max);
    case "enum":
      return property.values[0];
    case "integer":
      return clamp(
        0,
        property.min === null ? null : Math.ceil(property.min),
        property.max === null ? null : Math.floor(property.max),
      );
    case "number":
      return clamp(0, property.min, property.max);
    case "boolean":
      return true;
    case "date": {
      if (property.min !== null && EXAMPLE_DATE < property.min)
        return property.min;
      if (property.max !== null && EXAMPLE_DATE > property.max)
        return property.max;
      return EXAMPLE_DATE;
    }
    case "list": {
      const count = Math.min(property.max, Math.max(property.min, 1));
      const { of } = property;
      // Findings categories count once each: distinct items.
      return Array.from({ length: count }, (_, index) =>
        of.type === "enum"
          ? of.values[index % of.values.length]
          : exampleOf(of),
      );
    }
    case "object":
      return exampleObject(property.properties);
  }
}

const exampleObject = (properties: Record<string, ResolvedProperty>) =>
  Object.fromEntries(
    Object.entries(properties).map(([name, p]) => [name, exampleOf(p)]),
  );

/** An example of the whole shape, every optional property included. */
export function exampleValue(shape: ResolvedShape) {
  return exampleObject(shape.properties);
}

function range(
  min: number | string | null,
  max: number | string | null,
  unit = "",
) {
  if (min !== null && max !== null) return `from ${min} to ${max}${unit}`;
  if (min !== null) return `at least ${min}${unit}`;
  if (max !== null) return `at most ${max}${unit}`;
  return "";
}

const words = (values: string[]) => values.map((v) => `\`${v}\``).join(", ");

/**
 * Whether a property is an object of findings counts: on a header line it
 * is written `0 blocker / 1 major`, one count per category.
 */
export const isCounts = (property: ResolvedProperty) =>
  property.type === "object" && property.role === "findings";

/** An object of counts as one header line: `0 blocker / 1 major`. */
export const countsText = (value: Record<string, unknown>) =>
  Object.entries(value)
    .map(([category, count]) => `${String(count)} ${category}`)
    .join(" / ");

/** What a value of the property must be, in a few words. */
function kindOf(property: ResolvedProperty, flat = false): string {
  if (flat && isCounts(property))
    return "one line of counts, `<count> <category>` separated by ` / ` (`0 blocker / 1 major`; `none` when every count is 0), with a count for each of these";
  switch (property.type) {
    case "string":
      return property.min > 0
        ? `text of ${property.min} to ${property.max} characters`
        : `text, at most ${property.max} characters`;
    case "enum":
      return `one of ${words(property.values)}`;
    case "integer":
    case "number":
      return numberKind(property);
    case "boolean":
      return "`true` or `false`";
    case "date":
      return `a quoted date, "YYYY-MM-DD"${bounded(range(property.min, property.max))}`;
    case "list":
      return listKind(property);
    case "object":
      return "an object with";
  }
}

const bounded = (bounds: string) => (bounds ? `, ${bounds}` : "");

function numberKind(
  property: Extract<ResolvedProperty, { type: "integer" | "number" }>,
) {
  const what = property.type === "integer" ? "a whole number" : "a number";
  const unit = property.unit ? ` (${property.unit})` : "";
  return `${what}${bounded(range(property.min, property.max))}${unit}`;
}

function listKind(property: Extract<ResolvedProperty, { type: "list" }>) {
  const count =
    property.min > 0
      ? `${property.min} to ${property.max} items`
      : `at most ${property.max} items`;
  const each =
    property.of.type === "object" ? "objects with" : kindOf(property.of);
  const once = property.role === "findings" ? ", each at most once" : "";
  return `a list of ${count}${once}, each ${each}`;
}

const ROLE_WORDS: Record<string, string> = {
  verdict: "your verdict",
  findings: "your findings",
  usage: "what you used, as you measured it",
  kind: "its kind",
};

/**
 * One bullet per property, nested ones indented under their parent. `flat`
 * describes header lines: an object of findings counts is one line there.
 */
export function propertyLines(
  properties: Record<string, ResolvedProperty>,
  depth: number,
  flat = false,
): string[] {
  const indent = "  ".repeat(depth);
  return Object.entries(properties).flatMap(([name, property]) => {
    const need = property.optional ? "optional" : "required";
    const role = property.role ? `; ${ROLE_WORDS[property.role]}` : "";
    const kind = kindOf(property, flat);
    const nested =
      property.type === "object"
        ? property.properties
        : property.type === "list" && property.of.type === "object"
          ? property.of.properties
          : null;
    const text = property.for ? ` ${property.for}` : "";
    const line = `${indent}- \`${name}\` (${need}${role}): ${kind}${nested ? ":" : "."}${text}`;
    return [line, ...(nested ? propertyLines(nested, depth + 1) : [])];
  });
}

/** Paths, from the top, of the date properties a value has. */
function datePaths(
  properties: Record<string, ResolvedProperty>,
  value: Record<string, unknown>,
  at: (string | number)[] = [],
): (string | number)[][] {
  return Object.entries(properties).flatMap(([name, property]) => {
    const here = [...at, name];
    const item = value[name];
    if (property.type === "date") return [here];
    if (property.type === "object")
      return datePaths(
        property.properties,
        item as Record<string, unknown>,
        here,
      );
    if (property.type === "list") {
      const { of } = property;
      return (item as unknown[]).flatMap((each, index) =>
        of.type === "date"
          ? [[...here, index]]
          : of.type === "object"
            ? datePaths(of.properties, each as Record<string, unknown>, [
                ...here,
                index,
              ])
            : [],
      );
    }
    return [];
  });
}

/** The fenced example: YAML with dates quoted, so no reader takes one for a timestamp. */
export function fencedExample(
  shape: ResolvedShape,
  agent: string,
  value: Record<string, unknown>,
) {
  const document = new Document({ agent, ...value });
  for (const path of datePaths(shape.properties, value)) {
    const node = document.getIn(path, true);
    if (isScalar(node)) node.type = Scalar.QUOTE_DOUBLE;
  }
  // Short objects on one line, as people write receipts.
  visit(document, {
    Map(_key, node) {
      if (node !== document.contents && isMap(node)) node.flow = true;
    },
  });
  return document.toString({ lineWidth: 0 }).trimEnd();
}

type Header = {
  title: string;
  aliases?: Record<string, string>;
  mode_prefix: boolean;
};

/** Each property under the key a header line gives it: its alias, else its name. */
export function keyedProperties(
  properties: Record<string, ResolvedProperty>,
  aliases: Record<string, string> = {},
) {
  const keyed = Object.fromEntries(
    Object.entries(aliases).map(([key, to]) => [to, key]),
  );
  return Object.fromEntries(
    Object.entries(properties).map(([n, p]) => [keyed[n] ?? n, p]),
  );
}

/**
 * The flat header form's `key: value` lines, one per property: a list is
 * its items separated by commas, an object of findings counts is
 * `0 blocker / 1 major`.
 */
export function headerLines(
  aliases: Record<string, string> = {},
  value: Record<string, unknown>,
  shape: ResolvedShape,
) {
  const keyOf = (name: string) =>
    Object.entries(aliases).find(([, to]) => to === name)?.[0] ?? name;
  // The header reader takes the verdict word in any case; legacy receipts
  // write it in capitals (`PASS`), so the example does too.
  const shown = (name: string, item: unknown) => {
    const property = shape.properties[name];
    if (property?.role === "verdict") return String(item).toUpperCase();
    if (property && isCounts(property))
      return countsText(item as Record<string, unknown>);
    return Array.isArray(item) ? item.join(", ") : String(item);
  };
  return Object.entries(value).map(
    ([name, item]) => `${keyOf(name)}: ${shown(name, item)}`,
  );
}

/** The flat header form: a title line, then one `key: value` line per property. */
function headerExample(
  header: Header,
  agent: string,
  value: Record<string, unknown>,
  shape: ResolvedShape,
) {
  return [
    header.title.replace("{agent}", agent),
    ...headerLines(header.aliases, value, shape),
  ].join("\n");
}

type Binding = CompiledContracts["bindings"][number];
type Compiled = CompiledContracts["shapes"][string];

/** A receipt binding as the engine's reader takes it, pinned by its digest. */
export function receiptContract(
  binding: Binding,
  compiled: Compiled,
): ReceiptContract {
  const header =
    binding.options.format === "header"
      ? (binding.options.header as Header)
      : null;
  return {
    name: binding.name.slice("receipt:".length),
    format: header ? "header" : "fenced",
    header: header
      ? {
          title: header.title,
          aliases: header.aliases ?? {},
          mode_prefix: header.mode_prefix,
        }
      : null,
    contract: compiled.contract,
    shape: compiled.shape,
  };
}

/** The receipt an agent ends with: its name, binding and shape, or null. */
export function receiptOf(contracts: CompiledContracts, agent: string) {
  const declared = contracts.agents[agent];
  const name =
    declared === undefined
      ? contracts.bindings.some((b) => b.name === `receipt:${agent}`)
        ? agent
        : null
      : declared.receipt;
  if (name === null) return null;
  const binding = contracts.bindings.find((b) => b.name === `receipt:${name}`)!;
  const compiled = contracts.shapes[binding.shape!]!;
  return { name, binding, compiled };
}

/**
 * The section for an agent's receipt, or "" when it has none. Its example
 * is checked against the contract here, so a section never shows one that
 * the contract would refuse.
 */
export function receiptSection(
  contracts: CompiledContracts | null,
  agent: string,
): string {
  const receipt = contracts ? receiptOf(contracts, agent) : null;
  if (!receipt) return "";
  const { name, binding, compiled } = receipt;
  const { shape } = compiled;
  const value = exampleValue(shape);
  const issues = validateValue(shape, value);
  if (issues.length > 0)
    throw new CliError(
      `Can't make an example of receipt ${name}: ${issues.map((i) => `${i.path}: ${i.code}`).join("; ")}. Check the bounds in its shape, ${binding.shape}.`,
    );
  const header =
    binding.options.format === "header"
      ? (binding.options.header as Header)
      : null;
  const about = shape.for ? [shape.for, ""] : [];
  const lines = [
    `${SECTION_BEGIN}: receipt ${name}, shape ${binding.shape}, contract ${compiled.contract.slice(0, 19)}. Written by nodrail from nodrail.yaml; change it there. -->`,
    "",
    "## Your receipt",
    "",
    ...about,
  ];
  const example =
    header === null
      ? ["```nodrail-receipt", fencedExample(shape, agent, value), "```"]
      : ["```text", headerExample(header, agent, value, shape), "```"];
  // Read back as the hook reads a final message, so what the section shows
  // is a receipt the hook takes.
  const reading = readContractReceipt(
    `Done.\n\n${example.join("\n")}\n`,
    receiptContract(binding, compiled),
    agent,
  );
  if (reading.state !== "valid")
    throw new CliError(
      `Can't make an example of receipt ${name} that reads back: ${reading.reason}.`,
    );
  if (header === null)
    lines.push(
      "End your final message with a receipt: a `nodrail-receipt` block that is the last thing in the message, with nothing after its closing fence. Only that last block is read. Nothing is taken from your prose, and a receipt that breaks these rules counts as no receipt.",
      "",
      `The block is YAML. Start it with \`agent: ${agent}\`, then give exactly these properties, and no others:`,
      "",
      ...propertyLines(shape.properties, 0),
      "",
      "For example:",
      "",
      ...example,
    );
  else {
    const title = header.title.replace("{agent}", agent);
    lines.push(
      `End your final message with a receipt: the line \`${title}\`, then one \`key: value\` line for each of these, and nothing after them. A list is its items separated by commas. A receipt that breaks these rules counts as no receipt.`,
      "",
      ...propertyLines(
        keyedProperties(shape.properties, header.aliases),
        0,
        true,
      ),
      "",
      "The verdict word may be in any case (`PASS` or `pass`); every other value is written exactly as listed.",
      ...(header.mode_prefix
        ? [
            "",
            "You may put your mode before the verdict word, as `<mode>: <verdict>`.",
          ]
        : []),
      "",
      "For example:",
      "",
      ...example,
    );
  }
  lines.push("", SECTION_END);
  return `${lines.join("\n")}\n`;
}

/** An agent file's body: its own instructions, then nodrail's section, if any. */
export const withSection = (instructions: string, section: string) =>
  section === "" ? instructions : `${instructions}\n${section}`;
