// The bytes of a proposed file, before any Markdown is read: strict UTF-8,
// no byte-order mark anywhere, no control or bidirectional-override
// characters, LF or CRLF line ends only, and the size counted in UTF-8 bytes
// of the complete file. Issues name a reason, never the content.

export type FileIssue = { path: string; code: string; message: string };

export type FileText = {
  text: string;
  /** UTF-8 bytes of the complete file. */
  bytes: number;
  /** True when any line ends with CRLF. */
  crlf: boolean;
};

export type TextResult =
  ({ ok: true } & FileText) | { ok: false; issue: FileIssue };

/** Lone halves of a surrogate pair: such a string has no UTF-8 form. */
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
/** C0 controls but tab, LF and CR; DEL; C1 controls; line/paragraph separators. */
const CONTROL =
  // oxlint-disable-next-line no-control-regex -- the point is to find them
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028\u2029]/;
/** Bidirectional overrides and isolates: text that reads unlike it renders. */
const BIDI = /[\u202A-\u202E\u2066-\u2069]/;
const BOM = "\uFEFF";
/** A CR not followed by LF: a line end the parser and the renderer disagree on. */
const LONE_CR = /\r(?!\n)/;

const fail = (code: string, message: string): TextResult => ({
  ok: false,
  issue: { path: "(file)", code, message },
});

const tooLarge = (max: number) =>
  fail("size", `expected at most ${max} bytes of UTF-8`);

/** UTF-8 bytes of a well-formed string. */
export const utf8Bytes = (text: string) =>
  new TextEncoder().encode(text).length;

function decode(input: Uint8Array, max: number) {
  if (input.length > max) return tooLarge(max);
  if (input[0] === 0xef && input[1] === 0xbb && input[2] === 0xbf)
    return fail("bom", "starts with a byte-order mark");
  try {
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(input);
    return { text, bytes: input.length };
  } catch {
    return fail("encoding", "isn't valid UTF-8");
  }
}

function measure(input: string, max: number) {
  if (LONE_SURROGATE.test(input)) return fail("encoding", "isn't valid UTF-8");
  // Every UTF-16 unit is at least one byte, so this bounds the work below.
  if (input.length > max) return tooLarge(max);
  const bytes = utf8Bytes(input);
  if (bytes > max) return tooLarge(max);
  return { text: input, bytes };
}

/** The text of a complete file, checked; `max` is in UTF-8 bytes. */
export function readText(input: string | Uint8Array, max: number): TextResult {
  const read =
    typeof input === "string" ? measure(input, max) : decode(input, max);
  if ("ok" in read) return read;
  const { text, bytes } = read;
  if (text.startsWith(BOM)) return fail("bom", "starts with a byte-order mark");
  if (text.includes(BOM)) return fail("bom", "has a byte-order mark inside");
  if (CONTROL.test(text)) return fail("control", "has a control character");
  if (BIDI.test(text))
    return fail("bidi", "has a bidirectional override character");
  if (LONE_CR.test(text))
    return fail("line-ending", "has a CR line end; use LF or CRLF");
  return { ok: true, text, bytes, crlf: text.includes("\r\n") };
}
