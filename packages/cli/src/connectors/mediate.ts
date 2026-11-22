// A mediated connection (preview, DC-02.2 provider side and DC-02.3): Nodrail
// sits between the agent and the provider, so it checks what a host hook
// can't. Hosts hand hooks a lossy copy of a tool's result (Claude passes
// only `structuredContent`; both hosts swap a large result for a "saved to
// <path>" note), so only a connection Nodrail runs can hold a result back.
//
// For each call: the arguments are checked against the operation's declared
// `input` before the provider is called, with the engine's `checkInput` (the
// policy hook's own check), and a refused call never reaches it. The provider is called once, never again by Nodrail. Its result is
// checked against the declared `output` before the agent may use it: an
// invalid or unreadable result is withheld, and the record keeps that the
// provider ran apart from whether its result conforms.
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  checkInput,
  checkValue,
  type InputCheck,
} from "@nodrail/policy-engine/contracts";
import { fingerprint } from "@nodrail/policy-engine/protocol";
import {
  PAYLOAD_BYTES,
  projectValue,
  type CompiledContracts,
  type CompiledShape,
} from "../contracts/engine.ts";
import type { Tool, ToolAnswer } from "./mcp-stdio.ts";
import { measureResult, type Measurement, type SummedPath } from "./measure.ts";

/** One declared slot of an operation: its binding and compiled shape. */
export type ContractSlot = {
  /** The binding, `input:<connection>.<operation>` or `output:…`. */
  binding: string;
  /** The surface: S03 for input, S06 for a memory write's input, S04 for output. */
  surface: "S03" | "S04" | "S06";
  /** The shape's name in the registry. */
  shape: string;
  compiled: CompiledShape;
};

/** What an operation declares; null where it declares nothing. */
export type OperationContracts = {
  input: ContractSlot | null;
  output: ContractSlot | null;
};

/**
 * The declared input and output of each operation of one connection, from
 * the compiled contracts. An operation that declares neither isn't listed.
 */
export function connectionContracts(
  contracts: CompiledContracts | null,
  connection: string,
): Map<string, OperationContracts> {
  const found = new Map<string, OperationContracts>();
  for (const binding of contracts?.bindings ?? []) {
    const match = /^(input|output):(.+)$/.exec(binding.name);
    if (!match || !binding.shape) continue;
    const [, slot, id] = match as unknown as [
      string,
      "input" | "output",
      string,
    ];
    if (!id.startsWith(`${connection}.`)) continue;
    const compiled = contracts!.shapes[binding.shape];
    if (!compiled) continue;
    const operation = id.slice(connection.length + 1);
    const entry = found.get(operation) ?? { input: null, output: null };
    entry[slot] = {
      binding: binding.name,
      surface: binding.surface as ContractSlot["surface"],
      shape: binding.shape,
      compiled,
    };
    found.set(operation, entry);
  }
  return found;
}

/**
 * Thrown by a tool when the call was never sent, as when the provider has
 * already exited: the call is recorded as not called, never as unknown.
 * Its message is Nodrail's own and holds no value.
 */
export class ProviderUnavailable extends Error {}

/** Issues name a path and a code, never a value. */
export type SafeIssue = { path: string; code: string };

/**
 * A value checked against a declared slot, as the run ledger and reporting
 * keep it. Field names follow the engine's receipt record and envelope:
 * `name`, `contract`, `state`, `issues`; `values` is the reporting
 * projection of a valid value, so nothing withheld or classified is in it.
 */
export type ContractCheck = {
  surface: ContractSlot["surface"];
  /** The binding, such as `output:stripe.refund`. */
  name: string;
  /** The shape's name. */
  shape: string;
  /** The full contract's digest. */
  contract: string;
  /** The reporting projection's digest. */
  projection: string;
  /** Unsupported: Nodrail couldn't read the value, so it can't call it valid. */
  state: "valid" | "invalid" | "unsupported";
  /** Where full validation ran. */
  at: "local";
  issues: SafeIssue[];
  /** Why the value couldn't be read, for unsupported; never the value. */
  reason: UnsupportedReason | null;
  values: Record<string, unknown> | null;
};

/** Why a result couldn't be read as one structured value. */
export type UnsupportedReason =
  /** One text block that isn't JSON. */
  | "not-json"
  /** No content, several blocks, or a block that isn't text (an image…). */
  | "content-form";

/**
 * What the provider did, apart from what it returned: `not-called` when
 * Nodrail refused the call, `unknown` when it stopped answering, so the
 * effect may or may not have happened.
 */
export type Execution = "succeeded" | "failed" | "not-called" | "unknown";

/** One call through a mediated connection, for the run ledger and reporting. */
export type MediatedCall = {
  type: "connection.call";
  /** Stable for this call; a later call by the agent is a new event. */
  event: string;
  connection: string;
  operation: string;
  occurred_at: string;
  producer: { class: "runtime-observed"; id: string };
  /** Null when the operation declares no input. */
  input: ContractCheck | null;
  execution: Execution;
  /** Null when the operation declares no output, or the provider didn't succeed. */
  result: ContractCheck | null;
  /** Whether the agent was given the provider's answer. */
  delivered: boolean;
};

/**
 * What a sink learns of a call beyond its record: the digest that binds
 * the exact arguments, and the `result.` amounts budgets sum. The record
 * holds neither.
 */
export type CallDetails = {
  /** `fingerprint` of the arguments: the host hook's `input_sha256` for the same call. */
  input_sha256: string;
  /** One reading per summed path of this operation, for a call that succeeded. */
  measured: Measurement[];
};

/** Keeps a call's record somewhere: a file, the run ledger. */
export type RecordSink = (call: MediatedCall, details: CallDetails) => void;

export type MediateOptions = {
  connection: string;
  contracts: CompiledContracts | null;
  /**
   * Receive every call's record, before the agent gets its answer. Each is
   * tried on its own: one that fails is reported and the rest still run.
   */
  record?: RecordSink | readonly RecordSink[];
  /** The `result.` paths budgets sum; those of other operations are ignored. */
  sums?: readonly SummedPath[];
  /** Where a record that can't be kept is reported; stderr by default. */
  warn?: (message: string) => void;
  now?: () => Date;
};

const bytes = (text: string) => Buffer.byteLength(text, "utf8");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const issueText = (issues: SafeIssue[]) =>
  issues.map((issue) => `${issue.path}: ${issue.code}`).join(", ");

/** A slot's check as recorded: issues as path and code, values only when valid. */
function recorded(slot: ContractSlot, checked: InputCheck): ContractCheck {
  const valid = checked.state === "valid";
  return {
    surface: slot.surface,
    name: slot.binding,
    shape: slot.shape,
    contract: slot.compiled.contract,
    projection: slot.compiled.projection.digest,
    state: checked.state,
    at: "local",
    issues: valid
      ? []
      : checked.issues.map(({ path, code }) => ({ path, code })),
    reason: null,
    values: valid
      ? projectValue(slot.compiled.projection, checked.value)
      : null,
  };
}

/**
 * Arguments, with the engine's `checkInput`: the very check the host hook
 * runs on the same call, strict and bounded at 16 KiB.
 */
const inputCheck = (slot: ContractSlot, args: Record<string, unknown>) =>
  recorded(
    slot,
    checkInput(
      {
        name: slot.binding,
        contract: slot.compiled.contract,
        shape: slot.compiled.shape,
      },
      args,
    ),
  );

/** A result value, with the engine's check bounded at the output limit. */
const outputCheck = (slot: ContractSlot, value: unknown) =>
  recorded(slot, checkValue(slot.compiled.shape, value, PAYLOAD_BYTES.output));

/** Over the limit before it is even parsed. */
const tooBig = (slot: ContractSlot) =>
  recorded(slot, {
    state: "invalid",
    reason: "(value): size",
    issues: [{ path: "(value)", code: "size" }],
  });

function unsupported(slot: ContractSlot, reason: UnsupportedReason) {
  return {
    surface: slot.surface,
    name: slot.binding,
    shape: slot.shape,
    contract: slot.compiled.contract,
    projection: slot.compiled.projection.digest,
    state: "unsupported",
    at: "local",
    issues: [],
    reason,
    values: null,
  } satisfies ContractCheck;
}

/**
 * The one value a result holds: its `structuredContent`, or else its only
 * block when that is text holding JSON. Anything else can't be checked.
 */
function readResult(
  slot: ContractSlot,
  answer: ToolAnswer,
): { check: ContractCheck; value: unknown } {
  if (answer.structuredContent !== undefined) {
    const value: unknown = answer.structuredContent;
    return { check: outputCheck(slot, value), value };
  }
  const content = answer.content ?? [{ type: "text", text: answer.text }];
  const [only] = content;
  if (
    content.length !== 1 ||
    !isRecord(only) ||
    only.type !== "text" ||
    typeof only.text !== "string"
  )
    return { check: unsupported(slot, "content-form"), value: undefined };
  // Too big is refused before it is parsed.
  if (bytes(only.text) > PAYLOAD_BYTES.output)
    return { check: tooBig(slot), value: undefined };
  let value: unknown;
  try {
    value = JSON.parse(only.text);
  } catch {
    return { check: unsupported(slot, "not-json"), value: undefined };
  }
  return { check: outputCheck(slot, value), value };
}

const refusedText = (
  connection: string,
  operation: string,
  input: ContractCheck,
) =>
  `Nodrail refused ${operation} before calling ${connection}: its arguments don't match the declared input contract ${input.shape} (${issueText(input.issues)}). Nothing was sent to the provider; correct the arguments and call again.`;

const ranText = (connection: string, operation: string) =>
  `${operation} ran on ${connection} and the provider reported success`;

const dontRepeat = (operation: string) =>
  `Its effect may already have happened: don't call ${operation} again to retry; check its outcome first.`;

function withheldText(
  connection: string,
  operation: string,
  result: ContractCheck,
) {
  const why =
    result.state === "invalid"
      ? `its result doesn't match the declared output contract ${result.shape} (${issueText(result.issues)})`
      : `Nodrail can't read its result as one structured value (${result.reason}), so it can't check it against the declared output contract ${result.shape}`;
  return `${ranText(connection, operation)}, but ${why}. Nodrail withholds the result: don't use it. ${dontRepeat(operation)}`;
}

const unknownText = (connection: string, operation: string) =>
  `${operation} on ${connection} stopped answering, so whether it took effect is unknown. Nodrail doesn't retry. ${dontRepeat(operation)}`;

/** The validated value, and only it, as the agent receives it. */
function delivered(answer: ToolAnswer, value: unknown): ToolAnswer {
  const text = JSON.stringify(value);
  return {
    text,
    content: [{ type: "text", text }],
    ...(answer.structuredContent !== undefined
      ? { structuredContent: value as Record<string, unknown> }
      : {}),
  };
}

/**
 * The tools of one connection, each call checked against its operation's
 * declared input and output. A tool whose operation declares neither runs
 * as before and is still recorded, with null checks: no claim is made.
 */
export function mediateTools(
  tools: readonly Tool[],
  options: MediateOptions,
): Tool[] {
  const declared = connectionContracts(options.contracts, options.connection);
  const now = options.now ?? (() => new Date());
  const warn =
    options.warn ?? ((message: string) => process.stderr.write(`${message}\n`));
  const sinks: readonly RecordSink[] =
    typeof options.record === "function"
      ? [options.record]
      : (options.record ?? []);
  const keep = (call: MediatedCall, details: CallDetails) => {
    for (const sink of sinks)
      try {
        sink(call, details);
      } catch (error) {
        warn(
          `nodrail: the record of ${call.operation} (event ${call.event}) couldn't be kept: ${(error as Error).message}`,
        );
      }
  };
  return tools.map((tool) => {
    const slots = declared.get(tool.name) ?? { input: null, output: null };
    return {
      ...tool,
      call: async (args) => {
        const base = {
          type: "connection.call" as const,
          event: randomUUID(),
          connection: options.connection,
          operation: tool.name,
          occurred_at: now().toISOString(),
          producer: {
            class: "runtime-observed" as const,
            id: `connector:${options.connection}`,
          },
        };
        const { answer, record, value } = await callOnce(
          tool,
          slots,
          options.connection,
          args,
        );
        const measured =
          record.execution === "succeeded"
            ? measureResult(options.sums ?? [], {
                connection: options.connection,
                operation: tool.name,
                shape: slots.output?.compiled.shape ?? null,
                result: value,
              })
            : [];
        // Kept before the agent gets its answer.
        keep(
          { ...base, ...record },
          { input_sha256: fingerprint(args), measured },
        );
        return answer;
      },
    };
  });
}

type Outcome = {
  answer: ToolAnswer;
  record: Pick<MediatedCall, "input" | "execution" | "result" | "delivered">;
  /** The validated result value, for measuring; undefined without one. */
  value?: unknown;
};

/** Input check, at most one provider call, result check. */
async function callOnce(
  tool: Tool,
  slots: OperationContracts,
  connection: string,
  args: Record<string, unknown>,
): Promise<Outcome> {
  const input = slots.input ? inputCheck(slots.input, args) : null;
  const failed = (text: string) => ({ text, isError: true });
  const not = { result: null, delivered: false } as const;
  if (input && input.state !== "valid")
    return {
      answer: failed(refusedText(connection, tool.name, input)),
      record: { input, execution: "not-called", ...not },
    };
  let answer: ToolAnswer;
  try {
    // Exactly one provider call: Nodrail never retries, whatever comes back.
    answer = await tool.call(args);
  } catch (error) {
    if (error instanceof ProviderUnavailable)
      return {
        answer: failed(
          `${tool.name} wasn't sent: ${connection} isn't running (${error.message}). Nothing reached the provider.`,
        ),
        record: { input, execution: "not-called", ...not },
      };
    return {
      answer: failed(unknownText(connection, tool.name)),
      record: { input, execution: "unknown", ...not },
    };
  }
  // A provider error is passed on as the provider wrote it: no result to check.
  const execution = answer.isError ? "failed" : "succeeded";
  if (answer.isError || !slots.output)
    return {
      answer,
      record: { input, execution, result: null, delivered: true },
    };
  const { check: result, value } = readResult(slots.output, answer);
  const usable = result.state === "valid";
  return {
    answer: usable
      ? delivered(answer, value)
      : failed(withheldText(connection, tool.name, result)),
    record: { input, execution, result, delivered: usable },
    value: usable ? value : undefined,
  };
}

/**
 * Records as JSON Lines in `<folder>/calls.jsonl`, one per call: the
 * project's data, beside the run ledger, never a file it locks.
 */
export function recordsFile(folder: string) {
  const file = join(folder, "calls.jsonl");
  return (call: MediatedCall) => {
    mkdirSync(folder, { recursive: true });
    appendFileSync(file, `${JSON.stringify(call)}\n`);
  };
}
