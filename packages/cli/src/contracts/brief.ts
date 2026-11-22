// Briefs (S02): the structured brief an agent is started with. The agent
// that starts another (a Team handoff) gets one marked section in its
// generated file: for each agent it may start that declares a brief, how to
// give it (a final `nodrail-brief` block, or `key: value` lines for a
// `format: header` brief), each property and an example that is read back
// with the engine's own reader, the one the hook checks each dispatch with.
import { agentName } from "@nodrail/policy-engine/hook-runs";
import type { SetupTeam } from "@nodrail/policy-engine/yaml";
import { CliError } from "../io.ts";
import {
  briefContracts,
  readBrief,
  type BriefContract,
  type CompiledContracts,
} from "./engine.ts";
import {
  exampleValue,
  fencedExample,
  headerLines,
  keyedProperties,
  propertyLines,
} from "./render.ts";

export const BRIEF_BEGIN = "<!-- nodrail:brief begin";
export const BRIEF_END = "<!-- nodrail:brief end -->";

/** The fence a brief block opens with. */
export const BRIEF_FENCE = "nodrail-brief";

/**
 * The brief an agent is started with: its shape, its compiled contract and
 * the contract the engine reads a dispatch with, or null.
 */
export function briefOf(contracts: CompiledContracts | null, agent: string) {
  const binding = contracts?.bindings.find((b) => b.name === `brief:${agent}`);
  const compiled = binding?.shape ? contracts!.shapes[binding.shape] : null;
  if (!binding || !compiled) return null;
  // The engine keys briefs by the agent's normalized name, as the hook does.
  const contract = briefContracts(contracts!)[agentName(agent)];
  return contract
    ? { agent, shape: binding.shape!, binding, compiled, contract }
    : null;
}

export type Brief = NonNullable<ReturnType<typeof briefOf>>;

/** The agents `from` may start, per the team's handoffs, that declare a brief. */
export function briefTargets(
  contracts: CompiledContracts | null,
  team: Pick<SetupTeam, "handoffs"> | null,
  from: string,
) {
  return (team?.handoffs ?? []).flatMap(({ from: who, to }) => {
    const brief = who === from ? briefOf(contracts, to) : null;
    return brief ? [brief] : [];
  });
}

/** Whether a prompt holds a brief block anywhere, final or not. */
export const mentionsBrief = (prompt: string) =>
  new RegExp(`(?:^|\\n)[ \\t]*(?:\`{3,}|~{3,})[ \\t]*${BRIEF_FENCE}`).test(
    prompt,
  );

/** The example a section shows, as the prompt it ends: a block, or lines. */
function exampleOf(agent: string, contract: BriefContract) {
  const value = exampleValue(contract.shape);
  return contract.format === "header"
    ? [
        "```text",
        `agent: ${agent}`,
        ...headerLines(contract.aliases ?? {}, value, contract.shape),
        "```",
      ]
    : ["```" + BRIEF_FENCE, fencedExample(contract.shape, agent, value), "```"];
}

/** The prompt an example stands for: header lines are given without a fence. */
const examplePrompt = (example: string[], contract: BriefContract) =>
  `Start on this.\n\n${(contract.format === "header" ? example.slice(1, -1) : example).join("\n")}\n`;

/** How to give a brief of this format, for the agent that starts another. */
function howTo(agent: string, contract: BriefContract) {
  return contract.format === "header"
    ? [
        `Give it as \`key: value\` lines in the prompt, one per property: \`agent: ${agent}\`, then these, each once. A list is its items separated by commas. Lines with other keys are prose and are not read.`,
      ]
    : [
        `End the prompt with a \`${BRIEF_FENCE}\` block: YAML, the last thing in the prompt, with nothing after its closing fence. Start the block with \`agent: ${agent}\`, then give exactly these properties, and no others:`,
      ];
}

/** One agent's part of the section: its properties and a checked example. */
function targetLines({ agent, shape, compiled, contract }: Brief) {
  const example = exampleOf(agent, contract);
  const reading = readBrief(examplePrompt(example, contract), contract, agent);
  if (reading.state !== "valid")
    throw new CliError(
      `Can't make an example of ${agent}'s brief that reads back: ${reading.reason}. Check the bounds in its shape, ${shape}.`,
    );
  const header = contract.format === "header";
  const properties = header
    ? keyedProperties(contract.shape.properties, contract.aliases ?? {})
    : contract.shape.properties;
  return [
    `### ${agent}`,
    "",
    `Brief ${shape}, contract ${compiled.contract.slice(0, 19)}.${compiled.shape.for ? ` ${compiled.shape.for}` : ""}`,
    "",
    ...howTo(agent, contract),
    "",
    ...propertyLines(properties, 0, header),
    "",
    "For example:",
    "",
    ...example,
    "",
  ];
}

/**
 * The section for an agent that starts others with a brief, or "" when it
 * starts none. Each example is read back before it is shown.
 */
export function briefSection(
  contracts: CompiledContracts | null,
  team: Pick<SetupTeam, "handoffs"> | null,
  from: string,
): string {
  const targets = briefTargets(contracts, team, from);
  if (targets.length === 0) return "";
  const names = targets.map((t) => t.agent).join(", ");
  const lines = [
    `${BRIEF_BEGIN}: briefs for ${names}. Written by nodrail from nodrail.yaml; change it there. -->`,
    "",
    "## Briefs for the agents you start",
    "",
    `When you start ${targets.length === 1 ? "this agent" : "one of these agents"}, give it its brief in the prompt, as below. The policy hook reads the brief before the agent starts: a missing or invalid brief, or one for another agent, stops the agent from starting. Only the brief is read; nothing is taken from your prose.`,
    "",
    ...targets.flatMap(targetLines),
    BRIEF_END,
  ];
  return `${lines.join("\n")}\n`;
}
