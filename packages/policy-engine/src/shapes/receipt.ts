// Reading a receipt against its declared contract (S01): the fenced
// `nodrail-receipt` block or the explicit flat header bridge, normalized to
// one typed value and checked by the one strict validator. The local hook
// and Cloud call this same function. Invalid has no usable verdict, and a
// verdict is never recovered from prose.
import { parse } from "yaml";
import { readReceiptBlock } from "../receipt-block.ts";
import { agentName } from "../names.ts";
import { headerValue } from "./receipt-values.ts";
import { headerMatcher, readHeaderBlock } from "./receipt-header.ts";
import type { CompiledContracts } from "./compile.ts";
import type { ResolvedShape } from "./types.ts";
import { findingsCount, validateValue } from "./validate.ts";

export type HeaderOptions = {
  /** Such as `RECEIPT {agent}`. */
  title: string;
  /** A line's key → the top-level property it fills. */
  aliases: Record<string, string>;
  /** Whether `<mode>:` may come before the verdict word. */
  mode_prefix: boolean;
};

/** What a runtime needs to read one agent's receipt: pinned by its digest. */
export type ReceiptContract = {
  /** The receipt's name in `receipts:`. */
  name: string;
  format: "fenced" | "header";
  header: HeaderOptions | null;
  /** The resolved shape's contract digest. */
  contract: string;
  shape: ResolvedShape;
};

/** A path and a reason, never the rejected value. */
export type ReceiptIssue = { path: string; code: string };

export type ReceiptReading =
  | {
      state: "valid";
      format: ReceiptContract["format"];
      value: Record<string, unknown>;
      verdict: string;
      /** Derived by the runtime from the findings role; null without one. */
      findings: number | null;
      /** Agent-reported, from the usage role: never a trusted measurement. */
      usage: { tokens?: number; usd?: number };
    }
  | {
      state: "invalid" | "missing";
      format: ReceiptContract["format"];
      /** Safe to show: names paths, agents and limits, never a value. */
      reason: string;
      issues: ReceiptIssue[];
    };

/** Bounded YAML: core schema, unique keys, few aliases. Briefs read the same. */
export const YAML_OPTIONS = {
  schema: "core",
  uniqueKeys: true,
  maxAliasCount: 50,
} as const;

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A reading decided before validation, or the value to validate. */
type Read = { done: ReceiptReading } | { value: Record<string, unknown> };

/**
 * No usable block ends the message. One that would, but is over 8 KiB, is
 * invalid (`size`); none at all, or one followed by more text, is missing
 * (`not-final`).
 */
function absent(
  contract: ReceiptContract,
  block: string,
  oversize: boolean,
): Read {
  const issues = [{ path: "(value)", code: oversize ? "size" : "not-final" }];
  return oversize
    ? invalid(contract, `the ${block} block is over 8 KiB`, issues)
    : {
        done: {
          state: "missing",
          format: contract.format,
          reason: `no ${block} block ends the message`,
          issues,
        },
      };
}

const rejected = (
  contract: ReceiptContract,
  reason: string,
  issues: ReceiptIssue[],
): ReceiptReading => ({
  state: "invalid",
  format: contract.format,
  reason,
  issues,
});

const invalid = (
  contract: ReceiptContract,
  reason: string,
  issues: ReceiptIssue[],
): Read => ({ done: rejected(contract, reason, issues) });

const sameAgent = (said: string, dispatched: string) =>
  agentName(said) === agentName(dispatched);

const mismatch = (
  contract: ReceiptContract,
  said: string,
  dispatched: string,
) =>
  invalid(
    contract,
    `the receipt names agent ${agentName(said)}, but ${agentName(dispatched)} was dispatched`,
    [{ path: "agent", code: "identity" }],
  );

/** The fenced block's value, `agent` taken out as the envelope's identity. */
function fenced(
  message: string,
  contract: ReceiptContract,
  dispatched: string,
): Read {
  const body = readReceiptBlock(message)?.body;
  if (body === undefined)
    return absent(
      contract,
      "nodrail-receipt",
      readReceiptBlock(message, Infinity) !== null,
    );
  let raw: unknown;
  try {
    raw = parse(body, YAML_OPTIONS);
  } catch {
    // Bad YAML, a key given twice or too many aliases.
    return invalid(contract, "the receipt block isn't valid YAML", [
      { path: "(value)", code: "parse" },
    ]);
  }
  if (!isRecord(raw))
    return invalid(contract, "the receipt block isn't a map of fields", [
      { path: "(value)", code: "type" },
    ]);
  const { agent, ...value } = raw;
  if (agent !== undefined) {
    if (typeof agent !== "string")
      return invalid(contract, "agent: expected the agent's name", [
        { path: "agent", code: "type" },
      ]);
    if (!sameAgent(agent, dispatched))
      return mismatch(contract, agent, dispatched);
  }
  return { value };
}

/** The header block's lines, mapped to the shape's properties. */
function header(
  message: string,
  contract: ReceiptContract,
  dispatched: string,
): Read {
  const options = contract.header ?? {
    title: "RECEIPT {agent}",
    aliases: {},
    mode_prefix: false,
  };
  const match = headerMatcher(options.title);
  const block = readHeaderBlock(message, match);
  if (!block)
    return absent(
      contract,
      options.title.replace("{agent}", agentName(dispatched)),
      readHeaderBlock(message, match, Infinity) !== null,
    );
  if (!sameAgent(block.agent, dispatched))
    return mismatch(contract, block.agent, dispatched);
  const mapped = headerValue(block.entries, contract.shape, options);
  return "duplicate" in mapped
    ? invalid(contract, `${mapped.duplicate}: given twice`, [
        { path: mapped.duplicate, code: "duplicate" },
      ])
    : { value: mapped.value };
}

const verdictOf = (shape: ResolvedShape, value: Record<string, unknown>) => {
  const name = Object.keys(shape.properties).find(
    (key) => shape.properties[key]!.role === "verdict",
  );
  return name === undefined ? null : value[name];
};

const usageOf = (shape: ResolvedShape, value: Record<string, unknown>) => {
  const name = Object.keys(shape.properties).find(
    (key) => shape.properties[key]!.role === "usage",
  );
  const found = name === undefined ? undefined : value[name];
  return isRecord(found) ? (found as { tokens?: number; usd?: number }) : {};
};

/**
 * The receipt that ends `message`, read as `contract` says, for the agent the
 * runtime observed being dispatched. Missing, invalid and valid stay
 * distinct; only a valid reading has a verdict.
 */
export function readContractReceipt(
  message: string,
  contract: ReceiptContract,
  dispatched: string,
): ReceiptReading {
  const read =
    contract.format === "header"
      ? header(message, contract, dispatched)
      : fenced(message, contract, dispatched);
  if ("done" in read) return read.done;
  const { value } = read;
  const issues = validateValue(contract.shape, value);
  if (issues.length)
    return rejected(
      contract,
      issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "),
      issues.map(({ path, code }) => ({ path, code })),
    );
  const verdict = verdictOf(contract.shape, value);
  return {
    state: "valid",
    format: contract.format,
    value,
    verdict: verdict as string,
    findings: findingsCount(contract.shape, value),
    usage: usageOf(contract.shape, value),
  };
}

/** Each agent's receipt contract in a compiled workspace, by agent name. */
export function receiptContracts(
  contracts: CompiledContracts,
): Record<string, ReceiptContract> {
  const found: Record<string, ReceiptContract> = {};
  for (const [agent, { receipt }] of Object.entries(contracts.agents)) {
    const binding = contracts.bindings.find(
      (item) => item.name === `receipt:${receipt}`,
    );
    const compiled = binding?.shape ? contracts.shapes[binding.shape] : null;
    if (receipt === null || !binding || !compiled) continue;
    const options = binding.options as {
      format: ReceiptContract["format"];
      header?: Partial<HeaderOptions>;
    };
    found[agentName(agent)] = {
      name: receipt,
      format: options.format,
      header:
        options.format === "header"
          ? {
              title: options.header?.title ?? "RECEIPT {agent}",
              aliases: options.header?.aliases ?? {},
              mode_prefix: options.header?.mode_prefix ?? false,
            }
          : null,
      contract: compiled.contract,
      shape: compiled.shape,
    };
  }
  return found;
}
