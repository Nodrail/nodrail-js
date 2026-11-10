// Redaction: removing what looks like a secret before a call is described.
// Every function here reads text an agent wrote, so each runs in linear time
// on bounded input.
import type { JsonValue } from "./protocol.ts";

/** Inputs larger than this are only fingerprinted, never sent. */
export const MAX_INLINE_INPUT = 16 * 1024;

const REDACTED = "[redacted]";
// A bare "key" is too common to hide, but OPENAI_KEY or private-key isn't.
const sensitiveWord =
  /token|secret|passw(?:or)?d|pwd|api[_-]?key|[_-]keys?$|credential|authorization/i;

/**
 * A value worth hiding. Something computed in place is code, not a secret, and
 * hiding it would hide what the command does.
 */
const secretValue = `"(?![^"]*[$\`])[^"]*"|'[^']*'|(?![^\\s&;|]*[$\`])[^\\s&;|]+`;

const secretPatterns: [RegExp, string][] = [
  // A whole header value, whatever scheme it uses.
  [
    /\b(authorization|proxy-authorization|cookie|set-cookie|x-api-key)(\s*:\s*)[^'"\n]+/gi,
    `$1$2${REDACTED}`,
  ],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`],
  [/([?&](?:key|sig|signature|auth|code)=)[^&\s'"]+/gi, `$1${REDACTED}`],
  [/(\s-u\s+)[^\s:]+:\S+/g, `$1${REDACTED}`],
  [/\b(mysql|mysqldump|mariadb)\b([^|;&\n]*\s-p)[^\s]+/g, `$1$2${REDACTED}`],
  [/(\/\/)[^/\s:@]+:[^/\s@]+@/g, `$1${REDACTED}@`],
  // Known token shapes, found anywhere: a shell joins 0'ghp_…'_ into one word,
  // and the token must still be found inside it.
  [
    /(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+)/g,
    REDACTED,
  ],
  // sk- and sk_ are common inside ordinary words (task-…), so they need no
  // letter or digit just before them.
  [/(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/g, REDACTED],
  // Stripe, GitLab, Google and npm.
  [/(?<![A-Za-z0-9])[sr]k_(?:live|test)_[A-Za-z0-9]{10,}/g, REDACTED],
  [
    /glpat-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{35}|npm_[A-Za-z0-9]{36}/g,
    REDACTED,
  ],
];

const nameChars = /[A-Za-z0-9_-]+/g;
const assignmentAt = /=|:\s*/y;
const spaceAt = /\s+/y;
const valueAt = new RegExp(`(?:${secretValue})`, "y");

/**
 * NAME=value, name: value, and --name value, found word by word. A pattern
 * that searched for the name anywhere took quadratic time on a long word, and
 * an agent writes the text.
 */
function redactNamedValues(text: string) {
  let shown = "";
  let copied = 0;
  for (const word of text.matchAll(nameChars)) {
    const start = word.index;
    if (start < copied || !sensitiveWord.test(word[0])) continue;
    let at = start + word[0].length;
    assignmentAt.lastIndex = at;
    const assignment = assignmentAt.exec(text);
    if (assignment) at += assignment[0].length;
    else {
      // A value after a space only counts when the name is really a flag, so a
      // path like ./tokens can't hide the argument that follows it.
      const isFlag =
        word[0].startsWith("-") &&
        (start === 0 || /\s/.test(text[start - 1] ?? ""));
      spaceAt.lastIndex = at;
      const space = isFlag ? spaceAt.exec(text) : null;
      if (!space) continue;
      at += space[0].length;
    }
    valueAt.lastIndex = at;
    const value = valueAt.exec(text);
    if (!value) continue;
    shown += text.slice(copied, at) + REDACTED;
    copied = at + value[0].length;
  }
  return shown + text.slice(copied);
}

/** Text longer than this is shortened before it is read, so reading stays fast. */
const MAX_REDACTED = MAX_INLINE_INPUT;

/**
 * At most MAX_REDACTED characters, cut at a space where there is one, so the
 * end of a secret can't survive as a fragment too short to recognise.
 */
export function bounded(value: string) {
  if (value.length <= MAX_REDACTED) return value;
  const head = value.slice(0, MAX_REDACTED);
  const space = head.search(/\s\S*$/);
  return `${space > 0 ? head.slice(0, space) : ""} … [shortened]`;
}

/**
 * Best effort: it removes what looks like a secret before anything leaves this
 * machine. The fingerprint sent beside it still binds the exact original.
 * Shortening a long value changes it too, so it counts as hidden.
 */
export const redact = (value: string) =>
  secretPatterns.reduce(
    (current, [pattern, replacement]) => current.replace(pattern, replacement),
    redactNamedValues(bounded(value)),
  );

/**
 * Each part of a command on its own, so a hidden header can't swallow what
 * comes after it. Separators inside quotes are part of the value.
 */
export function redactCommand(line: string) {
  let shown = "";
  let part = "";
  let quote: string | null = null;
  for (const char of line) {
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") quote = char;
    if (!quote && ";&|\n".includes(char)) {
      shown += redact(part) + char;
      part = "";
    } else part += char;
  }
  return shown + redact(part);
}

/** A key that names a secret, such as api_key or GITHUB_TOKEN. Linear on any key. */
const isSensitiveKey = (key: string) =>
  /^[A-Za-z0-9_-]+$/.test(key) && sensitiveWord.test(key);

export function redactJson(value: unknown): JsonValue {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(redactJson);
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        isSensitiveKey(key) ? REDACTED : redactJson(item),
      ]),
    );
  return value as JsonValue;
}
