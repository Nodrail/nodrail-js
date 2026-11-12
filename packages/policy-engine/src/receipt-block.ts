// Finding the receipt block that ends a message. No imports: hooks bundle
// this, and reading a receipt must not pull in git or the file system.

/** The longest receipt block, fences included, that counts. Cloud takes the same. */
export const MAX_RECEIPT_TEXT = 8192;

/** Only the end of a message is read, so a huge message costs no more than this. */
const SCAN = 16 * 1024;

const OPENING = /(?:^|\n)(`{3,}|~{3,})[ \t]*nodrail-receipt[ \t]*\n/g;

/** The opening fence of the last block in the text, or null. */
function lastOpening(message: string) {
  const from = Math.max(0, message.length - SCAN);
  const tail = message.slice(from);
  // A fence must start a line, and the cut may fall in the middle of one.
  const cutMidLine = from > 0 && message[from - 1] !== "\n";
  let last: RegExpExecArray | undefined;
  for (const match of tail.matchAll(OPENING))
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
export function readReceiptBlock(message: string) {
  const opening = lastOpening(message);
  if (!opening) return null;
  const text = message.slice(opening.start);
  if (text.length > MAX_RECEIPT_TEXT) return null;
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
