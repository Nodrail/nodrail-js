// `nodrail contracts` (preview): declared contracts from the terminal,
// offline and side-effect free. They read nodrail.yaml and its resources,
// and the file given; they write nothing and run no tool.
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import type { Command } from "../context.ts";
import { explain } from "../contracts/explain.ts";
import {
  checkInput,
  compileContracts,
  headerMatcher,
  PAYLOAD_BYTES,
  projectShape,
  projectValue,
  readBrief,
  readContractReceipt,
  validateValue,
  type CompiledContracts,
  type ReceiptContract,
  type ReceiptReading,
  type ValueIssue,
} from "../contracts/engine.ts";
import { briefOf, briefSection, mentionsBrief } from "../contracts/brief.ts";
import {
  countsText,
  isCounts,
  receiptContract,
  receiptOf,
  receiptSection,
} from "../contracts/render.ts";
import { policyItems } from "../contracts/sources.ts";
import { CliError, UsageError } from "../io.ts";
import { bundledCatalog } from "../project/catalog.ts";
import { MANIFEST_FILE } from "../project/lockfile.ts";
import { readProject, resolveWithContracts } from "../project/project.ts";

const USAGE = `Usage:
  nodrail contracts render <agent|brief:agent> The sections for an agent's file, or one brief's
  nodrail contracts validate <target> <file>   Check a sample against a contract
  nodrail contracts explain <binding|gate>     What it asks for, and what satisfies it
<target> is a binding (receipt:reviewer, brief:triage, input:stripe.refund,
output:stripe.refund) or a shape (shape:x, or its name).`;

/** The project here, resolved, with its contracts compiled. */
function here(root: string) {
  const project = readProject(root);
  if (project.manifest === null)
    throw new CliError(`No ${MANIFEST_FILE} here.`);
  const { resolution, contracts } = resolveWithContracts({
    root,
    manifest: project.manifest,
    previous: project.lock,
    catalog: bundledCatalog(),
  });
  const { items } = policyItems(resolution);
  return {
    contracts,
    items,
    team: resolution.setup.team,
  };
}

/**
 * A rule file's own `contracts` entry compiled, for a project whose
 * nodrail.yaml declares none: what explain reads evidence and gates from.
 * Null when there is none or it doesn't compile (`policy lock` says why).
 */
function ruleFileContracts(items: unknown[]): CompiledContracts | null {
  const entry = items.find(
    (item): item is { contracts: unknown } =>
      typeof item === "object" && item !== null && "contracts" in item,
  );
  if (!entry) return null;
  const result = compileContracts({ manifest: entry.contracts, policy: items });
  return result.ok ? result.contracts : null;
}

function declared(contracts: CompiledContracts | null): CompiledContracts {
  if (contracts === null)
    throw new CliError(
      `${MANIFEST_FILE} declares no contracts: add shapes: and receipts:, then give an Agent spec.receipt (preview).`,
    );
  return contracts;
}

type Team = ReturnType<typeof here>["team"];

/**
 * What nodrail writes into an agent's file: the briefs of the agents it
 * starts (its team's handoffs) and its own receipt. `brief:<agent>` is the
 * brief section alone, for an agent nodrail doesn't set up that starts it.
 */
function render(command: Command, contracts: CompiledContracts, team: Team) {
  const [agent, ...rest] = command.args.slice(1);
  if (!agent || rest.length > 0) throw new UsageError(USAGE);
  if (agent.startsWith("brief:")) {
    const target = agent.slice("brief:".length);
    if (!briefOf(contracts, target))
      throw new CliError(
        `${target} has no declared brief: no Agent ${target} with spec.brief.`,
      );
    const section = briefSection(
      contracts,
      { handoffs: [{ from: "", to: target }] },
      "",
    );
    command.print({ agent: target, section }, () => section.trimEnd());
    return;
  }
  const sections = [
    briefSection(contracts, team, agent),
    receiptOf(contracts, agent) ? receiptSection(contracts, agent) : "",
  ].filter((section) => section !== "");
  if (sections.length === 0)
    throw new CliError(
      `${agent} has no declared receipt and starts no agent with a brief: no Agent ${agent} with spec.receipt, no receipts.${agent} in ${MANIFEST_FILE}, and no handoff from ${agent} to an Agent with spec.brief.`,
    );
  const section = sections.join("\n");
  command.print({ agent, section }, () => section.trimEnd());
}

/** The binding, or shape, a target names. */
function targetOf(contracts: CompiledContracts, target: string) {
  const binding = contracts.bindings.find((b) => b.name === target);
  const name = binding
    ? binding.shape
    : target.startsWith("shape:")
      ? target.slice(6)
      : target;
  const compiled = name ? contracts.shapes[name] : undefined;
  if (!compiled)
    throw new CliError(
      `No binding or shape ${target}. Bindings: ${contracts.bindings.map((b) => b.name).join(", ") || "none"}; shapes: ${Object.keys(contracts.shapes).join(", ")}.`,
    );
  return { binding, name: name!, compiled };
}

const MAX_SAMPLE = PAYLOAD_BYTES.output;

/** The sample file as a value: YAML (core schema, unique keys) or JSON. */
function sampleValue(text: string) {
  try {
    return parse(text, { schema: "core", uniqueKeys: true }) as unknown;
  } catch (error) {
    throw new CliError(`Not YAML: ${(error as Error).message}`);
  }
}

/** The sample file's text, within the size a payload may have. */
function readSample(cwd: string, file: string) {
  const path = resolve(cwd, file);
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    throw new CliError(`No file ${file}.`);
  }
  if (size > MAX_SAMPLE)
    throw new CliError(`${file} is over ${MAX_SAMPLE} bytes.`);
  return readFileSync(path, "utf8");
}

type Binding = CompiledContracts["bindings"][number];

/**
 * A receipt's value without its `agent`, the identity a runtime checks
 * against who was dispatched, and an issue when it names another agent.
 */
function withoutIdentity(
  contracts: CompiledContracts,
  binding: Binding,
  value: unknown,
): { value: unknown; issues: ValueIssue[] } {
  if (typeof value !== "object" || value === null || !("agent" in value))
    return { value, issues: [] };
  const { agent, ...rest } = value as Record<string, unknown>;
  const allowed = receiptAgents(contracts, binding);
  const known = typeof agent === "string" && allowed.includes(agent);
  return {
    value: rest,
    issues: known
      ? []
      : [
          {
            path: "agent",
            code: "identity",
            message: `expected one of ${allowed.join(", ")}`,
          },
        ],
  };
}

/** The agents that end with a receipt; its own name when none is declared. */
function receiptAgents(contracts: CompiledContracts, binding: Binding) {
  const receipt = binding.name.slice("receipt:".length);
  const agents = Object.entries(contracts.agents)
    .filter(([, a]) => a.receipt === receipt)
    .map(([each]) => each);
  return agents.length > 0 ? agents : [receipt];
}

/** Whether the text holds a receipt's opening: its fence, or its header line. */
function mentionsReceipt(text: string, contract: ReceiptContract) {
  if (contract.header === null)
    return /(?:^|\n)[ \t]*(?:`{3,}|~{3,})[ \t]*nodrail-receipt/.test(text);
  const header = headerMatcher(contract.header.title);
  return text.split("\n").some((line) => header(line) !== null);
}

type Checked = {
  /** valid, invalid, or missing: no receipt ends the message. */
  state: "valid" | "invalid" | "missing";
  value: Record<string, unknown> | null;
  issues: { path: string; code: string; message?: string }[];
  /** The reader's reason, safe to show, for a message that isn't valid. */
  reason: string | null;
  /** Read from a message, as the hook reads one. */
  message: boolean;
  verdict?: string;
  findings?: number | null;
};

/**
 * A receipt sample read as the hook reads a final message, with the
 * engine's reader: fenced or header, the last block only, its identity
 * checked against each agent that ends with this receipt. A file with no
 * receipt in it is the receipt's properties, as YAML.
 */
function checkReceipt(
  contracts: CompiledContracts,
  binding: Binding,
  compiled: CompiledContracts["shapes"][string],
  text: string,
): Checked {
  const contract = receiptContract(binding, compiled);
  const agents = receiptAgents(contracts, binding);
  const readings: ReceiptReading[] = agents.map((agent) =>
    readContractReceipt(text, contract, agent),
  );
  const isIdentity = (reading: ReceiptReading) =>
    reading.state !== "valid" &&
    reading.issues.some((issue) => issue.code === "identity");
  const reading = readings.find((r) => !isIdentity(r)) ?? readings[0]!;
  if (reading.state === "missing" && !mentionsReceipt(text, contract)) {
    if (contract.header !== null)
      throw new CliError(
        `No ${contract.header.title.replace("{agent}", agents[0]!)} receipt in the file: give a message that ends with one.`,
      );
    const { value, issues } = withoutIdentity(
      contracts,
      binding,
      sampleValue(text),
    );
    issues.push(...validateValue(compiled.shape, value));
    return fromIssues(value, issues);
  }
  if (reading.state === "valid")
    return {
      ...fromIssues(reading.value, []),
      message: true,
      verdict: reading.verdict,
      findings: reading.findings,
    };
  return {
    ...fromReading(reading, `one of ${agents.join(", ")}`),
    message: true,
  };
}

/** A strict check's outcome: valid with the value, or invalid with its issues. */
const fromIssues = (value: unknown, issues: Checked["issues"]): Checked => ({
  state: issues.length === 0 ? "valid" : "invalid",
  value: issues.length === 0 ? (value as Record<string, unknown>) : null,
  issues,
  reason: null,
  message: false,
});

/** A reader's failed reading, its identity issue naming who was expected. */
const fromReading = (
  reading: {
    state: "invalid" | "missing" | "unobservable";
    reason: string;
    issues: Checked["issues"];
  },
  expected: string,
): Checked => ({
  state: reading.state === "unobservable" ? "missing" : reading.state,
  value: null,
  issues: reading.issues.map((issue) =>
    issue.code === "identity"
      ? { ...issue, message: `expected ${expected}` }
      : issue,
  ),
  reason: reading.reason,
  message: false,
});

/**
 * A brief sample, read with the engine's reader as the hook reads a
 * dispatch prompt: the last `nodrail-brief` block, or, for a `format:
 * header` brief, its `key: value` lines. A fenced brief's file with no
 * block in it is the brief's properties, as YAML.
 */
function checkBrief(
  contracts: CompiledContracts,
  binding: Binding,
  compiled: CompiledContracts["shapes"][string],
  text: string,
): Checked {
  const agent = binding.name.slice("brief:".length);
  const brief = briefOf(contracts, agent)!;
  if (brief.contract.format === "fenced" && !mentionsBrief(text))
    return checkValue(compiled, text);
  const reading = readBrief(text, brief.contract, agent);
  return reading.state === "valid"
    ? fromIssues(reading.value, [])
    : fromReading(reading, agent);
}

/**
 * An operation's input: the file is the call's arguments, checked as the
 * hook and the connection check them (strict, at most 16 KiB).
 */
function checkArguments(
  contracts: CompiledContracts,
  binding: Binding,
  text: string,
): Checked {
  const compiled = contracts.shapes[binding.shape!]!;
  const checked = checkInput(
    { name: binding.name, contract: compiled.contract, shape: compiled.shape },
    sampleValue(text),
  );
  return checked.state === "valid"
    ? fromIssues(checked.value, [])
    : { ...fromIssues(null, checked.issues), reason: checked.reason };
}

/** Any other target: the file is the value, as YAML or JSON. */
function checkValue(
  compiled: CompiledContracts["shapes"][string],
  text: string,
): Checked {
  const value = sampleValue(text);
  return fromIssues(value, validateValue(compiled.shape, value));
}

const issueLine = (issue: Checked["issues"][number]) =>
  `  ${issue.path}: ${issue.code}${issue.message === undefined || issue.message === issue.code ? "" : ` (${issue.message})`}`;

/**
 * The findings a valid receipt reports, as written on a header line: an
 * object of counts is `0 blocker / 1 major`, a list its categories.
 */
function findingsOf(
  shape: CompiledContracts["shapes"][string]["shape"],
  value: Record<string, unknown> | null,
) {
  const entry = Object.entries(shape.properties).find(
    ([, property]) => property.role === "findings",
  );
  const found = entry && value ? value[entry[0]] : undefined;
  if (found === undefined) return null;
  return isCounts(entry![1])
    ? countsText(found as Record<string, unknown>)
    : (found as unknown[]).join(", ") || "none";
}

/** What the reader made of a valid message: its verdict and findings. */
function readLine(
  { verdict, findings, value }: Checked,
  shape: CompiledContracts["shapes"][string]["shape"],
) {
  if (verdict === undefined) return [];
  const which = findingsOf(shape, value);
  const count =
    findings === null || findings === undefined
      ? ""
      : `, ${findings} finding${findings === 1 ? "" : "s"}${which === null ? "" : ` (${which})`}`;
  return [`Read as the hook reads it: verdict ${verdict}${count}`];
}

/** Why the whole receipt failed; a path's issue says it already. */
function reasonLine({ reason, issues, state }: Checked) {
  if (reason === null || !issues.some((issue) => issue.path === "(value)"))
    return [];
  return [
    `  ${reason}${state === "missing" ? `: it counts as no ${reason.includes("brief") ? "brief" : "receipt"}` : ""}.`,
  ];
}

/** A sample read as its binding is read: a receipt, a brief, or a value. */
function checkSample(
  contracts: CompiledContracts,
  binding: Binding | undefined,
  compiled: CompiledContracts["shapes"][string],
  text: string,
): Checked {
  if (binding?.surface === "S01")
    return checkReceipt(contracts, binding, compiled, text);
  if (binding?.surface === "S02")
    return checkBrief(contracts, binding, compiled, text);
  if (binding?.surface === "S03")
    return checkArguments(contracts, binding, text);
  return checkValue(compiled, text);
}

function validate(command: Command, contracts: CompiledContracts) {
  const [target, file, ...rest] = command.args.slice(1);
  if (!target || !file || rest.length > 0) throw new UsageError(USAGE);
  const { binding, name, compiled } = targetOf(contracts, target);
  const text = readSample(command.io.cwd, file);
  const checked = checkSample(contracts, binding, compiled, text);
  const projection = projectShape(compiled.shape);
  const valid = checked.state === "valid";
  const reported = valid ? projectValue(projection, checked.value!) : null;
  const label = binding?.name ?? `shape:${name}`;
  const subject = `${label} (shape ${name}, contract ${compiled.contract.slice(0, 19)})`;
  const lines = valid
    ? [
        `valid: ${file} against ${subject}`,
        ...readLine(checked, compiled.shape),
        `Reported (may leave this machine): ${JSON.stringify(reported)}`,
        `Withheld: ${projection.withheld.join(", ") || "nothing"}`,
      ]
    : [
        `${checked.state}: ${file} against ${subject}`,
        ...checked.issues.map(issueLine),
        ...reasonLine(checked),
      ];
  const read = checked.message
    ? {
        verdict: checked.verdict ?? null,
        findings: checked.findings ?? null,
        findingsLine: findingsOf(compiled.shape, checked.value),
      }
    : {};
  command.print(
    {
      target: label,
      shape: name,
      contract: compiled.contract,
      state: checked.state,
      valid,
      issues: checked.issues,
      ...read,
      reported,
      withheld: projection.withheld,
    },
    () => lines.join("\n"),
  );
  if (!valid) throw new CliError(`${file} doesn't match ${label}.`);
}

/** `nodrail contracts <render|validate|explain>`. */
export async function contracts(command: Command) {
  const [sub] = command.args;
  if (sub === "explain") {
    const [target, ...rest] = command.args.slice(1);
    if (!target || rest.length > 0) throw new UsageError(USAGE);
    const found = here(command.io.cwd);
    const text = explain(
      found.contracts ?? ruleFileContracts(found.items),
      found.items,
      target,
      found.team,
    );
    command.print({ target, text }, () => text);
    return;
  }
  if (sub !== "render" && sub !== "validate") throw new UsageError(USAGE);
  const project = here(command.io.cwd);
  const found = declared(project.contracts);
  if (sub === "render") render(command, found, project.team);
  else validate(command, found);
}
