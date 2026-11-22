// Checking what goes into an agent or a tool before it starts (S02, S03):
// a connection operation's input against its declared shape, the flat
// `key: value` lines of a header-style brief, and the value with its
// classified fields taken out before it is shown anywhere. No imports beyond
// the validator: a browser or a hook bundle can check a value exactly as the
// engine and Cloud do.
import { PAYLOAD_BYTES } from "./limits.ts";
import { headerValue } from "./receipt-values.ts";
import type { ResolvedProperty, ResolvedShape } from "./types.ts";
import { validateValue } from "./validate.ts";

/** A path and a reason, never the rejected value. */
export type InputIssue = { path: string; code: string };

/** An operation's declared input, pinned by its digest. */
export type InputContract = {
  /** The binding, such as `input:stripe.refund`. */
  name: string;
  contract: string;
  shape: ResolvedShape;
};

export type InputCheck =
  | { state: "valid"; value: Record<string, unknown> }
  | {
      state: "invalid";
      /** Safe to show: paths and codes, never a value. */
      reason: string;
      issues: InputIssue[];
    };

const bytes = (value: unknown) => {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    return Infinity;
  }
};

/** A value checked against a shape: over `max` bytes is `size`, then strict validation. */
export function checkValue(
  shape: ResolvedShape,
  value: unknown,
  max: number = PAYLOAD_BYTES.input,
): InputCheck {
  if (bytes(value) > max)
    return {
      state: "invalid",
      reason: `(value): over ${max / 1024} KiB`,
      issues: [{ path: "(value)", code: "size" }],
    };
  const issues = validateValue(shape, value);
  if (issues.length)
    return {
      state: "invalid",
      reason: issues
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join("; "),
      issues: issues.map(({ path, code }) => ({ path, code })),
    };
  return { state: "valid", value: value as Record<string, unknown> };
}

/**
 * A tool call's arguments against the operation's declared input, before
 * the provider is called. Strict: an argument the shape doesn't declare is
 * `unknown`, a value over 16 KiB is `size`.
 */
export const checkInput = (contract: InputContract, input: unknown) =>
  checkValue(contract.shape, input, PAYLOAD_BYTES.input);

/** What a classified value is shown as: never the value. */
export const CLASSIFIED = "[classified]";

function scrub(property: ResolvedProperty, value: unknown): unknown {
  if (property.classification !== null) return CLASSIFIED;
  if (property.type === "list" && Array.isArray(value))
    return value.map((item) => scrub(property.of, item));
  if (
    property.type === "object" &&
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  )
    return scrubObject(property.properties, value as Record<string, unknown>);
  return value;
}

function scrubObject(
  properties: Record<string, ResolvedProperty>,
  value: Record<string, unknown>,
) {
  const kept: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value))
    kept[key] = Object.hasOwn(properties, key)
      ? scrub(properties[key]!, item)
      : item;
  return kept;
}

/**
 * The value with every `secret` or `pii` property, its own or an
 * ancestor's, replaced by `[classified]`: what a reviewer, a log or a
 * request may see of a valid value. The projection (`projectValue`) is
 * stricter still: it keeps only what is reported.
 */
export const withoutClassified = (
  shape: ResolvedShape,
  value: Record<string, unknown>,
) => scrubObject(shape.properties, value);

/** Whether a shape classifies anything, so a value needs scrubbing at all. */
export function hasClassified(shape: ResolvedShape): boolean {
  const walk = (property: ResolvedProperty): boolean =>
    property.classification !== null ||
    (property.type === "list" && walk(property.of)) ||
    (property.type === "object" &&
      Object.values(property.properties).some(walk));
  return Object.values(shape.properties).some(walk);
}

/** `key: value`, optionally bulleted or bold; the key compared in lowercase. */
const LINE =
  /^[ \t]*(?:[-*][ \t]+)?\**([A-Za-z][A-Za-z0-9_-]{0,31})\**[ \t]*:\**[ \t]*(.*?)[ \t]*$/;

/**
 * The flat lines of a header-style brief, `issue: ENG-1` or `Budget: 80`,
 * wherever they are in the prompt: each line whose key (in lowercase) is an
 * alias or a property of the shape fills that property, typed as receipts'
 * header lines are. Other lines are prose and are dropped; a property two
 * lines fill is `duplicate`. `agent` is the dispatch's reserved identity.
 */
export function briefLines(
  prompt: string,
  shape: ResolvedShape,
  aliases: Record<string, string>,
):
  | { value: Record<string, unknown>; agent: string | null; found: number }
  | { duplicate: string } {
  const entries: [string, string][] = [];
  let agent: string | null = null;
  for (const line of prompt.split(/\r?\n/)) {
    if (line.length > 2048) continue;
    const match = LINE.exec(line);
    if (!match) continue;
    const key = match[1]!.toLowerCase();
    if (key === "agent") {
      if (agent !== null) return { duplicate: "agent" };
      agent = match[2]!;
    } else entries.push([key, match[2]!]);
  }
  const mapped = headerValue(entries, shape, { aliases, mode_prefix: false });
  if ("duplicate" in mapped) return mapped;
  return {
    value: mapped.value,
    agent,
    found: Object.keys(mapped.value).length,
  };
}
