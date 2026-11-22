// Finding the receipt block that ends a message. No imports: hooks bundle
// this, and reading a receipt must not pull in git or the file system.

/** The longest receipt block, fences included, that counts. Cloud takes the same. */
export const MAX_RECEIPT_TEXT = 8192;

/** Only the end of a message is read, so a huge message costs no more than this. */
const SCAN = 16 * 1024;

/** The fence that opens a block of this kind: `nodrail-receipt`, `nodrail-brief`. */
export type BlockKind = "nodrail-receipt" | "nodrail-brief";

const openings: Record<BlockKind, RegExp> = {
  "nodrail-receipt": /(?:^|\n)(`{3,}|~{3,})[ \t]*nodrail-receipt[ \t]*\n/g,
  "nodrail-brief": /(?:^|\n)(`{3,}|~{3,})[ \t]*nodrail-brief[ \t]*\n/g,
};

/** The opening fence of the last block in the text, or null. */
function lastOpening(message: string, kind: BlockKind, scan: number) {
  const from = Math.max(0, message.length - scan);
  const tail = message.slice(from);
  // A fence must start a line, and the cut may fall in the middle of one.
  const cutMidLine = from > 0 && message[from - 1] !== "\n";
  let last: RegExpExecArray | undefined;
  for (const match of tail.matchAll(openings[kind]))
    if (match.index > 0 || match[0].startsWith("\n") || !cutMidLine)
      last = match;
  if (!last) return null;
  const newline = last[0].startsWith("\n") ? 1 : 0;
  return {
    start: from + last.index + newline,
    after: from + last.index + last[0].length,
    fence: last[1] ?? "```",
  };
}

/**
 * The last receipt block of a message, from its opening fence to the end, and
 * its body. Null unless that block is the last thing in the message and no
 * longer than MAX_RECEIPT_TEXT. Linear in the message: no pattern here can
 * backtrack over what an agent wrote.
 */
export function readReceiptBlock(message: string, max = MAX_RECEIPT_TEXT) {
  return readLastBlock(message, "nodrail-receipt", max, SCAN);
}

/**
 * The last block of a kind, when it ends the message: from its opening
 * fence to the end, and its body; null otherwise, or when the block is
 * longer than `max`. Only the last `scan` characters are read.
 */
export function readLastBlock(
  message: string,
  kind: BlockKind,
  max: number,
  scan: number,
) {
  const opening = lastOpening(message, kind, scan);
  if (!opening) return null;
  const text = message.slice(opening.start);
  if (text.length > max) return null;
  const rest = message.slice(opening.after).trimEnd();
  if (!rest.endsWith(opening.fence)) return null;
  const body = rest.slice(0, rest.length - opening.fence.length);
  return { text, body: body.endsWith("\n") ? body.slice(0, -1) : body };
}

/**
 * The receipt block that ends a message, as written, or null. A hook can send
 * this text on and leave reading it to `parseReceipt`.
 */
export function receiptBlock(message: string): string | null {
  return readReceiptBlock(message)?.text ?? null;
}
