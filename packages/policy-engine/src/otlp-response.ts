/**
 * What an OTLP/HTTP receiver said about one export (reporting contract v2):
 * how many spans it kept, refused, or left unknown. A 200 with partial
 * success refuses some; a body that can't be read proves nothing, so its
 * spans are unknown, not sent. Statuses that may pass are retried with the
 * same span ids; any other refusal is final.
 */

export type Delivery =
  | { kind: "retry"; reason: string }
  | {
      kind: "answered";
      accepted: number;
      rejected: number;
      unknown: number;
      message: string | null;
    };

/** OTLP/HTTP: these may succeed later; anything else 4xx won't. */
const RETRYABLE = new Set([408, 429, 502, 503, 504]);

/** The most of a receiver's message kept in the status file. */
export const MAX_RECEIVER_MESSAGE = 200;

/**
 * A receiver's message as the status file keeps it: one line of printable
 * text, cut short. It is the receiver's text, and `nodrail status` prints
 * it, so control characters (terminal escapes, new lines) become spaces.
 */
function plainMessage(text: string) {
  // oxlint-disable-next-line no-control-regex -- the point is to remove them
  const plain = text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim();
  return plain ? plain.slice(0, MAX_RECEIVER_MESSAGE) : null;
}

function varint(body: Uint8Array, at: number): [number, number] {
  let value = 0;
  let scale = 1;
  for (let index = at; index < body.length && index < at + 10; index++) {
    const byte = body[index]!;
    value += (byte & 0x7f) * scale;
    if ((byte & 0x80) === 0) return [value, index + 1];
    scale *= 128;
  }
  throw new Error("not a protobuf varint");
}

/** ExportTraceServiceResponse { partial_success 1 { rejected_spans 1; error_message 2 } }. */
function protobufPartial(body: Uint8Array) {
  if (body.length === 0) return { rejected: 0, message: null };
  if (body[0] !== 0x0a) throw new Error("not an export response");
  const [length, start] = varint(body, 1);
  const inner = body.subarray(start, start + length);
  let rejected = 0;
  let message: string | null = null;
  let at = 0;
  while (at < inner.length) {
    const key = inner[at]!;
    if (key === 0x08) [rejected, at] = varint(inner, at + 1);
    else if (key === 0x12) {
      const [size, from] = varint(inner, at + 1);
      message = new TextDecoder().decode(inner.subarray(from, from + size));
      at = from + size;
    } else throw new Error("not an export response");
  }
  return { rejected, message };
}

function jsonPartial(body: Uint8Array) {
  const text = new TextDecoder().decode(body).trim();
  if (text === "") return { rejected: 0, message: null };
  const parsed = JSON.parse(text) as {
    partialSuccess?: { rejectedSpans?: unknown; errorMessage?: unknown };
  };
  if (typeof parsed !== "object" || parsed === null)
    throw new Error("not an export response");
  const rejected = Number(parsed.partialSuccess?.rejectedSpans ?? 0);
  if (!Number.isInteger(rejected) || rejected < 0)
    throw new Error("not an export response");
  const message = parsed.partialSuccess?.errorMessage;
  return {
    rejected,
    message: typeof message === "string" && message ? message : null,
  };
}

/** The receiver's answer to `count` spans. */
export async function deliveryOf(
  response: Response,
  count: number,
): Promise<Delivery> {
  if (RETRYABLE.has(response.status) || response.status >= 500)
    return {
      kind: "retry",
      reason: `the receiver answered ${response.status}`,
    };
  if (!response.ok)
    return {
      kind: "answered",
      accepted: 0,
      rejected: count,
      unknown: 0,
      message: `the receiver refused the batch with ${response.status}`,
    };
  const body = new Uint8Array(await response.arrayBuffer());
  const type = response.headers.get("content-type") ?? "";
  try {
    const { rejected, message } = type.includes("protobuf")
      ? protobufPartial(body)
      : jsonPartial(body);
    const refused = Math.min(rejected, count);
    return {
      kind: "answered",
      accepted: count - refused,
      rejected: refused,
      unknown: 0,
      message: message === null ? null : plainMessage(message),
    };
  } catch {
    return {
      kind: "answered",
      accepted: 0,
      rejected: 0,
      unknown: count,
      message: "the receiver's answer couldn't be read, so delivery is unknown",
    };
  }
}
