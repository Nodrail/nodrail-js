// The header bridge's mapping from `key: value` lines to a flat value. Lines
// are text, so this is where a line becomes the property's type: the verdict
// is the first word (after `<mode>:` when allowed), case-insensitive, with
// trailing punctuation stripped; numbers and booleans only when written
// exactly as one. Anything else stays text, and the strict validator then
// refuses it. Lines the contract doesn't map are dropped: the bridge alone
// tolerates them. No imports beyond types.
import type { ResolvedProperty, ResolvedShape } from "./types.ts";

type Options = { aliases: Record<string, string>; mode_prefix: boolean };

const TRAILING = /[.,;:!?)\]]+$/;
const word = (text: string) => text.toLowerCase().replace(TRAILING, "");

/** `plan: PLANNED · release: READY` → `PLANNED · release: READY`. */
const MODE = /^[A-Za-z][A-Za-z0-9_-]*:\s*/;

function verdictWord(text: string, modePrefix: boolean) {
  const rest = modePrefix ? text.replace(MODE, "") : text;
  return word(rest.trim().split(/\s+/)[0] ?? "");
}

const COUNT = /^\d{1,9}$/;

/**
 * The categories of a findings line, each with the count written next to
 * it, before or after (`0 blocker / 1 major`, `correctness 2 · scope-drift
 * 1`), or null when written without one (`tests, docs`). Parts are split at
 * `·`, `,`, `;`, `|` and `/`; a part with one word and one number pairs
 * them, a part with words only lists them. Null overall when a part is
 * neither, so a line that can't be read this way is never guessed at.
 */
function counted(text: string): [string, number | null][] | null {
  if (/^none\.?$/i.test(text.trim())) return [];
  const found: [string, number | null][] = [];
  for (const part of text.split(/[·,;|/]+/)) {
    const tokens = part.trim().split(/\s+/).map(word).filter(Boolean);
    if (!tokens.length) continue;
    const numbers = tokens.filter((token) => COUNT.test(token));
    const words = tokens.filter((token) => !COUNT.test(token));
    if (numbers.length === 0) words.forEach((item) => found.push([item, null]));
    else if (numbers.length === 1 && words.length === 1)
      found.push([words[0]!, Number(numbers[0])]);
    else return null;
  }
  return found;
}

/**
 * Categories as written: `0 blocker / 1 major`, `correctness 2 ·
 * scope-drift 1`, `tests, docs`, or none. A category written with a count
 * of 0 is not a finding, so it is left out.
 */
function categories(text: string) {
  const found = counted(text);
  if (found === null)
    // Unreadable as pairs: every word, as written, for the validator to judge.
    return text
      .split(/[\s·,;|/]+/)
      .map(word)
      .filter((item) => item && !COUNT.test(item));
  return found
    .filter(([, count]) => count === null || count > 0)
    .map(([item]) => item);
}

/**
 * A findings line as an object of counts (`0 blocker / 1 major / 0 minor`):
 * each category the object declares takes the count written next to it;
 * `none` is every declared count 0. A category without a count, or one the
 * object doesn't declare, stays in the value, so the validator refuses it;
 * a category left out is `required` there.
 */
function counts(text: string, property: ResolvedProperty) {
  const declared = property.type === "object" ? property.properties : {};
  const found = counted(text);
  if (found === null) return text;
  if (!found.length && /^none\.?$/i.test(text.trim()))
    return Object.fromEntries(Object.keys(declared).map((key) => [key, 0]));
  const value: Record<string, unknown> = {};
  for (const [item, count] of found) {
    const key = item.replace(/-/g, "_");
    if (Object.hasOwn(value, key)) return text;
    value[key] = count ?? item;
  }
  return value;
}

const INTEGER = /^-?\d{1,15}$/;
const NUMBER = /^-?\d{1,15}(?:\.\d{1,15})?$/;

function typed(property: ResolvedProperty, text: string, modePrefix: boolean) {
  if (property.role === "verdict") return verdictWord(text, modePrefix);
  switch (property.type) {
    case "enum":
      return word(text.trim());
    case "integer":
      return INTEGER.test(text) ? Number(text) : text;
    case "number":
      return NUMBER.test(text) ? Number(text) : text;
    case "boolean":
      return /^(true|false)$/i.test(text)
        ? text.toLowerCase() === "true"
        : text;
    case "list":
      return categories(text);
    case "object":
      return property.role === "findings" ? counts(text, property) : text;
    default:
      return text;
  }
}

/**
 * The property each line key fills: its alias, else a property of the same
 * name that no alias fills. An alias's target takes only its aliased key, so
 * an observer's `verdict:` line can't overwrite its `result:`.
 */
function targetOf(key: string, shape: ResolvedShape, options: Options) {
  if (Object.hasOwn(options.aliases, key)) return options.aliases[key]!;
  const aliased = Object.values(options.aliases);
  return Object.hasOwn(shape.properties, key) && !aliased.includes(key)
    ? key
    : null;
}

/** The flat value the lines say, or the property two lines both fill. */
export function headerValue(
  entries: [string, string][],
  shape: ResolvedShape,
  options: Options,
): { value: Record<string, unknown> } | { duplicate: string } {
  const value: Record<string, unknown> = {};
  for (const [key, text] of entries) {
    const target = targetOf(key, shape, options);
    const property = target === null ? undefined : shape.properties[target];
    if (target === null || !property) continue;
    if (Object.hasOwn(value, target)) return { duplicate: target };
    value[target] = typed(property, text, options.mode_prefix);
  }
  return { value };
}
