// The text side of the flat header bridge (S01, `format: header`): a
// `RECEIPT <agent>` line, optionally bold, then `key: value` lines to the
// end of the message. Read exactly as a team's existing ledger reads it today, so
// the team's agents keep their receipts while they migrate. No imports
// beyond the receipt limit and agent names: the Cloud hook bundles this.
import { agentName } from "../names.ts";
import { MAX_RECEIPT_TEXT } from "../receipt-block.ts";

/** Only the end of a message is read, as for fenced receipts. */
const SCAN = 16 * 1024;

/** `key: value`, optionally bulleted; keys are bare lowercase words. */
const ENTRY = /^\s*(?:[-*]\s+)?([a-z][a-z0-9_-]*):\s*(.*)$/;
/** A line with a colon whose head is no bare key: consumed, not captured. */
const UNKNOWN = /^\s*(?:[-*]\s+)?[^\n]*:.*$/;
/** A colon-less bullet, continuing a key whose value was left empty. */
const BULLET = /^\s*[-*]\s+\S/;
const BULLET_MARK = /^\s*[-*]\s+/;
/** A fence line: the block may sit in a code block, or start just outside one. */
const FENCE = /^\s*(?:`{3,}|~{3,})/;

/** The agent a header line names, or null when the line is no header. */
export type HeaderMatch = (line: string) => string | null;

export type HeaderBlock = {
  /** The agent the opening header names, as written. */
  agent: string;
  /** From the opening header to the end of the message. */
  text: string;
  /** Every `key: value` line, in order; a key given twice appears twice. */
  entries: [key: string, value: string][];
};

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const AGENT = "([A-Za-z0-9_-]{1,64})";
const matcher =
  (pattern: RegExp): HeaderMatch =>
  (line) =>
    pattern.exec(line)?.[1] ?? null;

/** Header lines for a configured title such as `RECEIPT {agent}`: bold optional. */
export function headerMatcher(title: string): HeaderMatch {
  const [before = "", after = ""] = title.split("{agent}");
  const words = escape(before).replace(/ +/g, "\\s+");
  return matcher(
    new RegExp(`^\\s*\\**\\s*${words}${AGENT}${escape(after)}\\s*\\**\\s*$`),
  );
}

/**
 * Header lines under a title of uppercase words with the agent after a
 * space (`RECEIPT qa`), when the title isn't known. A title that joins the
 * agent without a space (`RECEIPT-{agent}`) can't be split from the agent
 * without knowing who was dispatched: use `headerNaming`.
 */
export const anyHeader: HeaderMatch = matcher(
  new RegExp(
    `^\\s*\\**\\s*[A-Z][A-Z0-9_-]*(?:[ \\t]+[A-Z][A-Z0-9_-]*)*[ \\t]+${AGENT}\\s*\\**\\s*$`,
  ),
);

/** A line in bold or not: what is between the stars. */
const BOLD = /^\s*\**\s*(.*?)\s*\**\s*$/;
/** What a title may put before `{agent}`, as the grammar allows it. */
const TITLE_HEAD = /^[A-Z][A-Z0-9 \t_-]*$/;
const AGENT_TEXT = /^[A-Za-z0-9_-]{1,64}$/;
/** Title (31) and agent (64) with room for spacing: longer lines aren't headers. */
const MAX_HEADER_LINE = 128;

/**
 * Header lines under any title the grammar allows, naming `agent`: what the
 * Cloud hook uses, which knows the dispatched agent but not the configured
 * title, then sends the block on for Cloud to read with the title. The title
 * may end in a space, `-` or `_` (`RECEIPT {agent}`, `RECEIPT-{agent}`); the
 * agent compares as runs name agents.
 */
export function headerNaming(agent: string): HeaderMatch {
  const wanted = agentName(agent);
  return (line) => {
    if (line.length > MAX_HEADER_LINE) return null;
    const inner = BOLD.exec(line)?.[1] ?? "";
    // Each split of the line into a title and an agent, the shortest agent first.
    for (let cut = inner.length - 1; cut > 0; cut -= 1) {
      const said = inner.slice(cut);
      if (!AGENT_TEXT.test(said)) break;
      const head = inner.slice(0, cut);
      if (TITLE_HEAD.test(head) && agentName(said) === wanted) return said;
    }
    return null;
  };
}

type Scan = {
  entries: [string, string][];
  /** The entry a colon-less bullet continues, while its value started empty. */
  open: number | null;
  /** The last line the block consumed. */
  last: number;
};

/** For each line, the next line with text after it, or "" at the end. */
function nextTexts(lines: string[]) {
  const next: string[] = Array.from({ length: lines.length }, () => "");
  let found = "";
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    next[index] = found;
    if (lines[index]!.trim()) found = lines[index]!;
  }
  return next;
}

/** One line of the block; false when the block ends before it. */
function consume(line: string, index: number, next: string, scan: Scan) {
  if (FENCE.test(line)) return true;
  if (!line.trim())
    // A blank line ends the block unless a key line follows it.
    return ENTRY.test(next) || UNKNOWN.test(next) || FENCE.test(next);
  const entry = ENTRY.exec(line);
  if (entry) {
    const value = entry[2]!.trim();
    scan.entries.push([entry[1]!, value]);
    scan.open = value ? null : scan.entries.length - 1;
  } else if (UNKNOWN.test(line)) scan.open = null;
  else if (scan.open !== null && BULLET.test(line)) {
    const held = scan.entries[scan.open]!;
    const item = line.replace(BULLET_MARK, "").trim();
    held[1] = held[1] ? `${held[1]}; ${item}` : item;
  } else return false;
  scan.last = index;
  return true;
}

/**
 * The entries of the block a header opens, when it runs to the end: after
 * its last line only blank lines, fences and the same header repeated as a
 * closing line may follow. Anything else is a receipt quoted mid-message.
 */
type View = { lines: string[]; next: string[]; match: HeaderMatch };

function blockAt({ lines, next, match }: View, head: number, agent: string) {
  const scan: Scan = { entries: [], open: null, last: head };
  for (let index = head + 1; index < lines.length; index += 1)
    if (!consume(lines[index]!, index, next[index]!, scan)) break;
  for (const rest of lines.slice(scan.last + 1)) {
    const text = rest.trim();
    if (!text || FENCE.test(text)) continue;
    if (match(rest) === agent) continue;
    return null;
  }
  return scan.entries;
}

/**
 * The last header block that ends the message and carries at least one
 * `key: value` line, or null. A block longer than MAX_RECEIPT_TEXT is no
 * receipt. Linear in what is read: no pattern backtracks over agent text.
 */
export function readHeaderBlock(
  message: string,
  match: HeaderMatch,
  max = MAX_RECEIPT_TEXT,
): HeaderBlock | null {
  const from = Math.max(0, message.length - SCAN);
  const lines = message.slice(from).split("\n");
  // The cut may fall in the middle of a line, which then isn't a header.
  if (from > 0 && message[from - 1] !== "\n") lines[0] = "";
  const view = { lines, next: nextTexts(lines), match };
  for (let head = lines.length - 1; head >= 0; head -= 1) {
    const agent = match(lines[head]!);
    if (agent === null) continue;
    const entries = blockAt(view, head, agent);
    if (!entries?.length) continue;
    const text = lines.slice(head).join("\n").trimEnd();
    return text.length > max ? null : { agent, text, entries };
  }
  return null;
}
