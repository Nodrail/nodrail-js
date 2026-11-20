/**
 * OTLP/HTTP trace export bodies, as the OpenTelemetry protocol defines them,
 * for the one span shape Nodrail sends: in protobuf (the default every
 * receiver takes) or JSON. Written out here, so the engine needs no
 * OpenTelemetry dependency for a few fixed fields.
 */

export type SpanRecord = {
  /** 32 hex digits. */
  traceId: string;
  /** 16 hex digits. */
  spanId: string;
  name: string;
  /** Unix time in nanoseconds, as decimal text. */
  start: string;
  end: string;
  attributes: Record<string, string>;
};

export type OtlpProtocol = "otlp-http/protobuf" | "otlp-http/json";

const SCOPE = { name: "nodrail", version: "1" };
/** SPAN_KIND_INTERNAL. */
const INTERNAL = 1;

/** The request body and its content type. */
export function encodeSpans(
  spans: readonly SpanRecord[],
  resource: Record<string, string>,
  protocol: OtlpProtocol,
): { body: Uint8Array<ArrayBuffer>; contentType: string } {
  if (protocol === "otlp-http/json")
    return {
      body: new TextEncoder().encode(JSON.stringify(jsonBody(spans, resource))),
      contentType: "application/json",
    };
  return {
    body: protobufBody(spans, resource),
    contentType: "application/x-protobuf",
  };
}

const jsonAttributes = (attributes: Record<string, string>) =>
  Object.entries(attributes).map(([key, value]) => ({
    key,
    value: { stringValue: value },
  }));

function jsonBody(
  spans: readonly SpanRecord[],
  resource: Record<string, string>,
) {
  return {
    resourceSpans: [
      {
        resource: { attributes: jsonAttributes(resource) },
        scopeSpans: [
          {
            scope: SCOPE,
            spans: spans.map((span) => ({
              traceId: span.traceId,
              spanId: span.spanId,
              name: span.name,
              kind: INTERNAL,
              startTimeUnixNano: span.start,
              endTimeUnixNano: span.end,
              attributes: jsonAttributes(span.attributes),
            })),
          },
        ],
      },
    ],
  };
}

// Protobuf: each field is a tag (field number and wire type) and its value.
// Messages and strings are length-delimited (wire type 2); times are fixed64
// (wire type 1); the span kind is a varint (wire type 0).

function varint(value: number | bigint): number[] {
  let rest = BigInt(value);
  const bytes: number[] = [];
  do {
    let byte = Number(rest & 0x7fn);
    rest >>= 7n;
    if (rest > 0n) byte |= 0x80;
    bytes.push(byte);
  } while (rest > 0n);
  return bytes;
}

const tag = (field: number, wire: number) => varint((field << 3) | wire);

const bytesField = (field: number, bytes: Uint8Array | number[]) => [
  ...tag(field, 2),
  ...varint(bytes.length),
  ...bytes,
];

const stringField = (field: number, text: string) =>
  bytesField(field, new TextEncoder().encode(text));

function fixed64(field: number, decimal: string) {
  let rest = BigInt(decimal);
  const bytes: number[] = [];
  for (let index = 0; index < 8; index++) {
    bytes.push(Number(rest & 0xffn));
    rest >>= 8n;
  }
  return [...tag(field, 1), ...bytes];
}

const hex = (text: string) =>
  Array.from({ length: text.length / 2 }, (_, index) =>
    Number.parseInt(text.slice(index * 2, index * 2 + 2), 16),
  );

/** KeyValue { key = 1; AnyValue value = 2 { string_value = 1 } }. */
const keyValue = (field: number, key: string, value: string) =>
  bytesField(field, [
    ...stringField(1, key),
    ...bytesField(2, stringField(1, value)),
  ]);

const attributes = (field: number, values: Record<string, string>) =>
  Object.entries(values).flatMap(([key, value]) => keyValue(field, key, value));

/** Span: trace_id 1, span_id 2, name 5, kind 6, start 7, end 8, attributes 9. */
const span = (record: SpanRecord) => [
  ...bytesField(1, hex(record.traceId)),
  ...bytesField(2, hex(record.spanId)),
  ...stringField(5, record.name),
  ...tag(6, 0),
  ...varint(INTERNAL),
  ...fixed64(7, record.start),
  ...fixed64(8, record.end),
  ...attributes(9, record.attributes),
];

/**
 * ExportTraceServiceRequest { ResourceSpans resource_spans = 1 {
 *   Resource resource = 1 { attributes = 1 }; ScopeSpans scope_spans = 2 {
 *   InstrumentationScope scope = 1 { name 1, version 2 }; Span spans = 2 } } }
 */
function protobufBody(
  spans: readonly SpanRecord[],
  resource: Record<string, string>,
) {
  const scope = [
    ...stringField(1, SCOPE.name),
    ...stringField(2, SCOPE.version),
  ];
  const scopeSpans = [
    ...bytesField(1, scope),
    ...spans.flatMap((record) => bytesField(2, span(record))),
  ];
  const resourceSpans = [
    ...bytesField(1, attributes(1, resource)),
    ...bytesField(2, scopeSpans),
  ];
  return Uint8Array.from(bytesField(1, resourceSpans));
}
