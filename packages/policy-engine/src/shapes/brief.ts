// Reading the brief an agent is started with (S02) against its declared
// contract: the fenced `nodrail-brief` block that ends the dispatch prompt
// (the last one, read as receipts are: a block quoted mid-prompt or followed
// by more text doesn't count), or, opted
// in per agent, flat `key: value` lines. Normalized to one typed value and
// checked by the one strict validator. The contract is chosen by the agent
// the dispatch call starts, never by anything the prompt says; the local
// hook, the CLI and Cloud call these same functions.
import { parse } from "yaml";
import { agentName } from "../names.ts";
import { readLastBlock } from "../receipt-block.ts";
import { isRecord, YAML_OPTIONS } from "./receipt.ts";
import type { CompiledContracts } from "./compile.ts";
import {
  briefLines,
  checkValue,
  type InputContract,
  type InputIssue,
} from "./inputs.ts";
import { PAYLOAD_BYTES } from "./limits.ts";
import type { ResolvedShape } from "./types.ts";

/** One agent's brief contract, pinned by its digest. */
export type BriefContract = {
  /** The brief's shape name. */
  name: string;
  format: "fenced" | "header";
  /** Header briefs: a line's key → the top-level property it fills. */
  aliases: Record<string, string> | null;
  contract: string;
  shape: ResolvedShape;
};

export type BriefReading =
  | {
      state: "valid";
      format: BriefContract["format"];
      value: Record<string, unknown>;
    }
  | {
      /**
       * invalid: a brief that breaks the contract; missing: no brief in the
       * prompt; unobservable: the host doesn't show the hook the prompt.
       */
      state: "invalid" | "missing" | "unobservable";
      format: BriefContract["format"];
      /** Safe to show: names paths, agents and limits, never a value. */
      reason: string;
      issues: InputIssue[];
    };

type Failed = Exclude<BriefReading, { state: "valid" }>;

const failed = (
  contract: BriefContract,
  state: Failed["state"],
  reason: string,
  issues: InputIssue[],
): Failed => ({ state, format: contract.format, reason, issues });

/** Only the end of a prompt is read for the block, as for receipts. */
const SCAN = 2 * PAYLOAD_BYTES.brief;

const mismatch = (contract: BriefContract, said: string, dispatched: string) =>
  failed(
    contract,
    "invalid",
    `the brief names agent ${agentName(said)}, but ${agentName(dispatched)} is being started`,
    [{ path: "agent", code: "identity" }],
  );

function fenced(
  prompt: string,
  contract: BriefContract,
  dispatched: string,
): Failed | { value: unknown } {
  const block = readLastBlock(prompt, "nodrail-brief", Infinity, SCAN);
  if (!block)
    return failed(
      contract,
      "missing",
      "no nodrail-brief block ends the prompt",
      [{ path: "(value)", code: "not-final" }],
    );
  if (block.text.length > PAYLOAD_BYTES.brief)
    return failed(
      contract,
      "invalid",
      "the nodrail-brief block is over 16 KiB",
      [{ path: "(value)", code: "size" }],
    );
  const { body } = block;
  let raw: unknown;
  try {
    raw = parse(body, YAML_OPTIONS);
  } catch {
    return failed(contract, "invalid", "the brief block isn't valid YAML", [
      { path: "(value)", code: "parse" },
    ]);
  }
  if (!isRecord(raw))
    return failed(
      contract,
      "invalid",
      "the brief block isn't a map of fields",
      [{ path: "(value)", code: "type" }],
    );
  const { agent, ...value } = raw;
  if (agent !== undefined) {
    if (typeof agent !== "string")
      return failed(contract, "invalid", "agent: expected the agent's name", [
        { path: "agent", code: "type" },
      ]);
    if (agentName(agent) !== agentName(dispatched))
      return mismatch(contract, agent, dispatched);
  }
  return { value };
}

function header(
  prompt: string,
  contract: BriefContract,
  dispatched: string,
): Failed | { value: unknown } {
  if (new TextEncoder().encode(prompt).length > 4 * PAYLOAD_BYTES.brief)
    return failed(
      contract,
      "invalid",
      "the prompt is too long to read brief lines from",
      [{ path: "(value)", code: "size" }],
    );
  const lines = briefLines(prompt, contract.shape, contract.aliases ?? {});
  if ("duplicate" in lines)
    return failed(contract, "invalid", `${lines.duplicate}: given twice`, [
      { path: lines.duplicate, code: "duplicate" },
    ]);
  if (lines.agent !== null && agentName(lines.agent) !== agentName(dispatched))
    return mismatch(contract, lines.agent, dispatched);
  if (lines.found === 0)
    return failed(
      contract,
      "missing",
      "the prompt has none of the brief's lines",
      [{ path: "(value)", code: "required" }],
    );
  return { value: lines.value };
}

/**
 * The brief in `prompt`, read as `contract` says, for the agent the
 * dispatch call starts. Null `prompt` means the host doesn't show it
 * (unobservable). Missing, invalid, unobservable and valid stay distinct;
 * only a valid reading has a value.
 */
export function readBrief(
  prompt: string | null,
  contract: BriefContract,
  dispatched: string,
): BriefReading {
  if (prompt === null)
    return failed(
      contract,
      "unobservable",
      "this host doesn't show the hook the brief an agent is started with",
      [{ path: "(value)", code: "unobservable" }],
    );
  const read =
    contract.format === "header"
      ? header(prompt, contract, dispatched)
      : fenced(prompt, contract, dispatched);
  if ("state" in read) return read;
  const checked = checkValue(contract.shape, read.value, PAYLOAD_BYTES.brief);
  return checked.state === "valid"
    ? { state: "valid", format: contract.format, value: checked.value }
    : failed(contract, "invalid", checked.reason, checked.issues);
}

const compiledShape = (contracts: CompiledContracts, name: string) => {
  const binding = contracts.bindings.find((item) => item.name === name);
  const compiled = binding?.shape ? contracts.shapes[binding.shape] : null;
  return binding && compiled ? { binding, compiled } : null;
};

/** Each agent's brief contract in a compiled workspace, by agent name. */
export function briefContracts(
  contracts: CompiledContracts,
): Record<string, BriefContract> {
  const found: Record<string, BriefContract> = {};
  for (const agent of Object.keys(contracts.agents)) {
    const bound = compiledShape(contracts, `brief:${agent}`);
    if (!bound) continue;
    const options = bound.binding.options as {
      format?: "header";
      header?: { aliases?: Record<string, string> };
    };
    const format = options.format === "header" ? "header" : "fenced";
    found[agentName(agent)] = {
      name: bound.binding.shape!,
      format,
      aliases: format === "header" ? (options.header?.aliases ?? {}) : null,
      contract: bound.compiled.contract,
      shape: bound.compiled.shape,
    };
  }
  return found;
}

/**
 * Each declared operation input in a compiled workspace, by
 * `<connection>.<operation>`: the tool and operation a call to it is
 * judged as.
 */
export function inputContracts(
  contracts: CompiledContracts,
): Record<string, InputContract> {
  const found: Record<string, InputContract> = {};
  for (const binding of contracts.bindings) {
    if (!binding.name.startsWith("input:") || !binding.shape) continue;
    const compiled = contracts.shapes[binding.shape];
    if (!compiled) continue;
    found[binding.name.slice("input:".length)] = {
      name: binding.name,
      contract: compiled.contract,
      shape: compiled.shape,
    };
  }
  return found;
}
