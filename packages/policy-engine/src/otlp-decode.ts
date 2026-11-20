import type { SpanRecord } from "./otlp.ts";

/**
 * Reading OTLP/HTTP trace export bodies, protobuf or JSON, for a receiver
 * of what Nodrail sends (the team view). Only what a span needs: ids, name,
 * times and attributes with string, bool or int values; anything else is
 * skipped. A body that isn't one throws.
 */

export type ReceivedSpans = {
  resource: Record<string, string>;
  spans: SpanRecord[];
};

type Field = {
  field: number;
  wire: number;
  bytes?: Uint8Array;
  value?: bigint;
};

const malformed = () => new Error("not an OTLP trace export");

function readVarint(body: Uint8Array, at: number): [bigint, number] {
  let value = 0n;
  let shift = 0n;
  for (let index = at; index < body.length && shift < 70n; index++) {
    const byte = body[index]!;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [value, index + 1];
    shift += 7n;
  }
  throw malformed();
}

function readFixed(
  body: Uint8Array,
  at: number,
  size: number,
): [bigint, number] {
  if (at + size > body.length) throw malformed();
  let value = 0n;
  for (let index = size - 1; index >= 0; index--)
    value = (value << 8n) | BigInt(body[at + index]!);
  return [value, at + size];
}

/** One message's fields, in order. */
function fields(body: Uint8Array): Field[] {
  const out: Field[] = [];
  let at = 0;
  while (at < body.length) {
    const [key, next] = readVarint(body, at);
    const field = Number(key >> 3n);
    const wire = Number(key & 7n);
    if (wire === 2) {
      const [length, start] = readVarint(body, next);
      const end = start + Number(length);
      if (end > body.length) throw malformed();
      out.push({ field, wire, bytes: body.subarray(start, end) });
      at = end;
    } else if (wire === 0 || wire === 1 || wire === 5) {
      const [value, end] =
        wire === 0
          ? readVarint(body, next)
          : readFixed(body, next, wire === 1 ? 8 : 4);
      out.push({ field, wire, value });
      at = end;
    } else throw malformed();
  }
  return out;
}

const text = (bytes: Uint8Array | undefined) =>
  new TextDecoder("utf-8", { fatal: true }).decode(bytes);
const hex = (bytes: Uint8Array | undefined) =>
  Array.from(bytes ?? [], (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
const each = (list: Field[], field: number) =>
  list.filter((one) => one.field === field && one.bytes);

/** AnyValue { string 1; bool 2; int 3 }: as text, or null when it's another kind. */
function anyValue(bytes: Uint8Array | undefined): string | null {
  for (const one of fields(bytes ?? new Uint8Array())) {
    if (one.field === 1 && one.bytes) return text(one.bytes);
    if (one.field === 2 && one.wire === 0) return String(one.value !== 0n);
    if (one.field === 3 && one.wire === 0)
      return BigInt.asIntN(64, one.value!).toString();
  }
  return null;
}

function protoAttributes(list: Field[], field: number) {
  const out: Record<string, string> = {};
  for (const pair of each(list, field)) {
    const parts = fields(pair.bytes!);
    const key = parts.find((one) => one.field === 1)?.bytes;
    const value = anyValue(parts.find((one) => one.field === 2)?.bytes);
    if (key && value !== null) out[text(key)] = value;
  }
  return out;
}

function protoSpan(bytes: Uint8Array): SpanRecord {
  const parts = fields(bytes);
  const one = (field: number) => parts.find((part) => part.field === field);
  return {
    traceId: hex(one(1)?.bytes),
    spanId: hex(one(2)?.bytes),
    name: text(one(5)?.bytes),
    start: (one(7)?.value ?? 0n).toString(),
    end: (one(8)?.value ?? 0n).toString(),
    attributes: protoAttributes(parts, 9),
  };
}

function fromProtobuf(body: Uint8Array): ReceivedSpans[] {
  return each(fields(body), 1).map((resourceSpans) => {
    const parts = fields(resourceSpans.bytes!);
    const resource = each(parts, 1)[0]?.bytes;
    return {
      resource: resource ? protoAttributes(fields(resource), 1) : {},
      spans: each(parts, 2).flatMap((scope) =>
        each(fields(scope.bytes!), 2).map((span) => protoSpan(span.bytes!)),
      ),
    };
  });
}

type JsonValue = {
  stringValue?: unknown;
  boolValue?: unknown;
  intValue?: unknown;
};
type JsonAttribute = { key?: unknown; value?: JsonValue };

function jsonAttributes(list: unknown) {
  const out: Record<string, string> = {};
  if (!Array.isArray(list)) return out;
  for (const { key, value } of list as JsonAttribute[]) {
    if (typeof key !== "string" || !value) continue;
    const found = [value.stringValue, value.boolValue, value.intValue].find(
      (each) =>
        typeof each === "string" ||
        typeof each === "boolean" ||
        typeof each === "number",
    );
    if (found !== undefined) out[key] = String(found);
  }
  return out;
}

type JsonSpan = Record<string, unknown>;

/** A JSON field as text: strings and numbers only, else the fallback. */
const scalar = (value: unknown, fallback = "") =>
  typeof value === "string" || typeof value === "number"
    ? String(value)
    : fallback;

function fromJson(body: Uint8Array): ReceivedSpans[] {
  const parsed = JSON.parse(text(body)) as { resourceSpans?: unknown };
  if (!Array.isArray(parsed?.resourceSpans)) throw malformed();
  return (
    parsed.resourceSpans as {
      resource?: { attributes?: unknown };
      scopeSpans?: { spans?: JsonSpan[] }[];
    }[]
  ).map((resourceSpans) => ({
    resource: jsonAttributes(resourceSpans.resource?.attributes),
    spans: (resourceSpans.scopeSpans ?? []).flatMap((scope) =>
      (scope.spans ?? []).map((span) => ({
        traceId: scalar(span.traceId),
        spanId: scalar(span.spanId),
        name: scalar(span.name),
        start: scalar(span.startTimeUnixNano, "0"),
        end: scalar(span.endTimeUnixNano, "0"),
        attributes: jsonAttributes(span.attributes),
      })),
    ),
  }));
}

/** The spans in an export body, by its content type. */
export function decodeSpans(
  body: Uint8Array,
  contentType: string,
): ReceivedSpans[] {
  try {
    if (contentType.startsWith("application/json")) return fromJson(body);
    if (contentType.startsWith("application/x-protobuf"))
      return fromProtobuf(body);
  } catch {
    throw malformed();
  }
  throw malformed();
}
