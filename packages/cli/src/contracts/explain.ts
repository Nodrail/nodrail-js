// `nodrail contracts explain` (preview): what a binding or a gate asks for,
// and what would satisfy it, from the declarations alone. It reads; it runs
// no tool and no agent.
import { CliError } from "../io.ts";
import {
  evidenceBindingLines,
  evidenceNeedLines,
  explainBudget,
} from "./accountable-explain.ts";
import {
  projectShape,
  type CompiledContracts,
  type ResolvedProperty,
} from "./engine.ts";
import {
  bindingOf,
  itemName,
  propertyPaths,
  reportedPaths,
  unreportedConditions,
} from "./paths.ts";
import { isCounts } from "./render.ts";

type Condition = CompiledContracts["consumers"][number]["conditions"][number];
type Item = Record<string, unknown>;

const SURFACE_WORDS: Record<string, string> = {
  S01: "a receipt the agent ends its final message with",
  S02: "the brief an agent is started with",
  S03: "a tool call's input",
  S04: "a tool call's result",
  S05: "evidence",
  S06: "a memory record",
  S07: "a file",
  S08: "an approval form",
  S09: "inventory labels",
};

/** One condition, as a person reads it. */
export function conditionText(condition: Condition) {
  const path = condition.path.join(".");
  switch (condition.op) {
    case "eq":
      return `${path} is ${String(condition.value)}`;
    case "in":
      return `${path} is one of ${condition.values.join(", ")}`;
    case "range":
      if (condition.min !== null && condition.max !== null)
        return `${path} is from ${condition.min} to ${condition.max}`;
      return condition.min !== null
        ? `${path} is at least ${condition.min}`
        : `${path} is at most ${String(condition.max)}`;
  }
}

/** A property's type in a few words; findings counts as a header writes them. */
function typeWords(property: ResolvedProperty) {
  if (property.type === "enum") return `one of ${property.values.join(", ")}`;
  if (property.type === "list") return `list of ${property.of.type}`;
  if (isCounts(property))
    return `counts of ${Object.keys(property.type === "object" ? property.properties : {}).join(", ")} (a header line writes them \`0 blocker / 1 major\`)`;
  return property.type;
}

/** Each property, one line: its path, whether required, its type and reporting. */
function propertyRows(
  properties: Record<string, ResolvedProperty>,
  reported: Set<string>,
): string[] {
  return propertyPaths(properties).map(({ path, property }) => {
    const role = property.role ? `, role ${property.role}` : "";
    return `    ${path}: ${property.optional ? "optional" : "required"}, ${typeWords(property)}${role}${reported.has(path) ? ", reported" : ""}`;
  });
}

/** Where a consumer is declared, as its rule's or gate's name. */
function consumerName(at: string, items: Item[]) {
  const [root, index] = at.split(".");
  return itemName(root === "policy" ? items[Number(index)] : undefined, at);
}

/** Who starts the agent a brief is for, by the team's handoffs. */
function briefLines(binding: Binding, team: Team) {
  const agent = binding.name.slice("brief:".length);
  const from = (team?.handoffs ?? [])
    .filter((handoff) => handoff.to === agent)
    .map((handoff) => handoff.from);
  const format =
    binding.options.format === "header"
      ? "header, `key: value` lines in the prompt the agent is started with"
      : "fenced, a final ```nodrail-brief block in the prompt the agent is started with";
  return [
    `  Format: ${format}`,
    `  Started by: ${from.length > 0 ? `${from.join(", ")}, whose agent files describe it` : `no handoff to ${agent}; \`nodrail contracts render brief:${agent}\` prints the section for the agent that starts it`}`,
    "  Satisfied by: a brief valid against the whole contract, for this agent, read by the hook before the agent starts (Claude Code, Copilot). A missing or invalid brief keeps the agent from starting. A prose prompt is not a brief.",
    "  On Codex the hook can't read the prompt, so starting this agent is denied there.",
  ];
}

/** Where a connection operation's input or result is checked. */
function connectionLines(binding: Binding) {
  const [, id] = binding.name.split(":") as [string, string];
  const [connection, ...operation] = id.split(".");
  const call = `${operation.join(".")} on ${connection}`;
  return binding.surface === "S04"
    ? [
        `  Checked: on the result of ${call}, by the connection Nodrail runs, before the agent gets it. An invalid or unreadable result is withheld; the call is recorded as having run.`,
      ]
    : [
        `  Checked: on the arguments of ${call}, by the policy hook before any rule judges the call, and by the connection Nodrail runs before the provider is called. A call that doesn't conform never reaches it.`,
        "  Rules and gates read the checked arguments with `where` on `input.` paths.",
      ];
}

type Binding = CompiledContracts["bindings"][number];
/** The team, for who starts whom; null without one. */
type Team = { handoffs: { from: string; to: string }[] } | null;

/** What satisfies a receipt, a brief or a connection slot, and who it belongs to. */
function surfaceLines(
  contracts: CompiledContracts,
  binding: Binding,
  team: Team,
) {
  if (binding.surface === "S02") return briefLines(binding, team);
  if (binding.surface === "S05") return evidenceBindingLines(binding);
  if (binding.surface === "S03" || binding.surface === "S04")
    return connectionLines(binding);
  if (binding.surface !== "S01") return [];
  const receipt = binding.name.slice("receipt:".length);
  const agents = Object.entries(contracts.agents)
    .filter(([, a]) => a.receipt === receipt)
    .map(([agent, a]) => (a.implicit ? `${agent} (by its name)` : agent));
  const format =
    binding.options.format === "header"
      ? "header, the flat RECEIPT form"
      : "fenced, a final ```nodrail-receipt block";
  return [
    `  Format: ${format}`,
    `  Agents: ${agents.length > 0 ? agents.join(", ") : `none declared; \`nodrail contracts render ${receipt}\` prints its section`}`,
    "  Satisfied by: a receipt that ends the agent's final message and is valid against the whole contract, read by the hook when the agent stops (Claude Code, Copilot). It is agent-reported: it proves the receipt conforms, not that what it says is true.",
    "  On Codex nothing captures it yet, so a gate that waits for it stays closed.",
  ];
}

const STATUS: Record<string, string> = {
  S01: "enforced by the hook",
  S02: "enforced by the hook",
  S03: "enforced by the hook and the connection Nodrail runs",
  S05: "enforced by the hook, engine level 5",
  S04: "preview: checked by the connection Nodrail runs",
};

function explainBinding(
  contracts: CompiledContracts,
  name: string,
  items: Item[],
  team: Team,
) {
  const binding = contracts.bindings.find((b) => b.name === name);
  const shapeName = binding
    ? binding.shape
    : name.startsWith("shape:")
      ? name.slice(6)
      : null;
  const compiled = shapeName ? contracts.shapes[shapeName] : undefined;
  if (!compiled || (!binding && !name.startsWith("shape:"))) return null;
  const projection = projectShape(compiled.shape);
  const reported = new Set(
    reportedPaths(compiled.shape).map((each) => each.path),
  );
  const lines = [
    binding
      ? `${name} (${binding.surface}, ${STATUS[binding.surface] ?? "preview: not enforced yet"}): ${SURFACE_WORDS[binding.surface]}`
      : `${name} (preview: not attached here)`,
    `  Shape: ${shapeName}, contract ${compiled.contract}`,
    `  Projection: ${compiled.projection.digest}`,
    ...(binding ? surfaceLines(contracts, binding, team) : []),
  ];
  lines.push(
    "  Properties:",
    ...propertyRows(compiled.shape.properties, reported),
    `  Reported (may leave this machine): ${[...reported].join(", ") || "nothing"}`,
    `  Withheld: ${projection.withheld.join(", ") || "nothing"}`,
  );
  // Rules name no binding: their where reads one by its root.
  const unread = unreportedConditions(contracts, items).filter(
    (each) => each.binding === name,
  );
  const readers = contracts.consumers.filter(
    (c) =>
      c.bindings.includes(name) ||
      c.conditions.some(
        ({ path }) =>
          bindingOf(path[0], items[Number(c.at.split(".")[1])]) === name,
      ),
  );
  if (readers.length > 0)
    lines.push(
      "  Read by:",
      ...readers.map((c) => {
        const verdicts = c.detail.verdicts as string[] | undefined;
        const where = consumerName(c.at, items);
        const authority = c.detail.authority;
        const parts = [
          ...(verdicts ? [`verdict ${verdicts.join(" or ")}`] : []),
          ...(binding?.surface === "S05" && typeof authority === "string"
            ? [`authority ${authority}`]
            : []),
          ...c.conditions.map((condition) =>
            unread.some(
              (each) =>
                each.where === where && each.path === condition.path.join("."),
            )
              ? `${conditionText(condition)} (not reported, so never met in Nodrail Cloud)`
              : conditionText(condition),
          ),
        ];
        return `    ${where}: ${parts.join("; ") || "any valid value"}`;
      }),
    );
  return lines;
}

/** A rule file's value as text: a string as it is, anything else as JSON. */
const text = (value: unknown) =>
  typeof value === "string" ? value : JSON.stringify(value);

const asList = (value: unknown) =>
  Array.isArray(value) ? value.map(text) : [text(value)];

function explainGate(
  contracts: CompiledContracts | null,
  item: Item,
  index: number,
  items: Item[] = [],
) {
  const requires = Array.isArray(item.requires)
    ? (item.requires as Item[])
    : [];
  const action = [item.tool, item.operation].filter(Boolean).join(" ");
  const lines = [
    `Gate "${text(item.gate)}"${item.id ? ` (id ${text(item.id)})` : ""}`,
    `  Holds ${action || "the actions it matches"}${item.agent ? ` by ${text(item.agent)}` : ""} until every requirement is met; until then: ${text(item.otherwise ?? item.effect ?? "deny")}.`,
    "  Requirements:",
  ];
  requires.forEach((need, at) => {
    if (need.evidence !== undefined) {
      const ref = contracts?.consumers.find(
        (c) => c.at === `policy.${index}.requires.${at}`,
      );
      lines.push(
        ...evidenceNeedLines(contracts, need, at, {
          compiled: (ref?.conditions ?? []).map(conditionText),
          items,
        }),
      );
      return;
    }
    const agent = text(need.agent);
    const words = asList(need.verdict);
    const since = need.since === undefined ? [] : asList(need.since);
    lines.push(
      `    ${at + 1}. ${agent} gives verdict ${words.join(" or ")}${since.length > 0 ? `, after the last step of ${since.join(", ")}` : ""}`,
    );
    const receipt = contracts?.agents[agent]?.receipt ?? null;
    if (receipt === null) {
      lines.push(
        `       ${agent} has no declared receipt: a receipt whose verdict is ${words.join(" or ")} satisfies it.`,
      );
      return;
    }
    const ref = contracts!.consumers.find(
      (c) => c.at === `policy.${index}.requires.${at}`,
    );
    lines.push(
      `       Read from receipt:${receipt}: only a receipt valid against its contract counts, and its verdict must be ${words.join(" or ")}. Authority: agent-reported.`,
      ...(ref?.conditions ?? []).map((c) => `       And ${conditionText(c)}.`),
    );
  });
  lines.push(
    "  A gate only holds an action back: meeting it never allows what no rule allows.",
  );
  return lines;
}

/**
 * The explanation of a binding (receipt:x, brief:x, input:c.op, output:c.op,
 * shape:x) or a gate (its name or id).
 */
export function explain(
  contracts: CompiledContracts | null,
  items: unknown[],
  target: string,
  team: Team = null,
): string {
  const rows = items as Item[];
  const binding = contracts
    ? explainBinding(contracts, target, rows, team)
    : null;
  if (binding) return binding.join("\n");
  const index = rows.findIndex(
    (item) =>
      typeof item === "object" &&
      item !== null &&
      item.gate !== undefined &&
      (item.gate === target || item.id === target),
  );
  if (index >= 0)
    return explainGate(contracts, rows[index]!, index, rows).join("\n");
  const budget = explainBudget(rows, target);
  if (budget) return budget;
  const known = [
    ...(contracts?.bindings.map((b) => b.name) ?? []),
    ...rows.flatMap((item) =>
      typeof item?.gate === "string"
        ? [`"${item.gate}"`]
        : typeof item?.budget === "string"
          ? [`"${item.budget}"`]
          : [],
    ),
  ];
  throw new CliError(
    `No binding or gate ${target}.${known.length > 0 ? ` Known: ${known.join(", ")}.` : ""}`,
  );
}
