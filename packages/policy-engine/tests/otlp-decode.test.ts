// Reading what Nodrail sends: the team view's receiver decodes the same
// bodies the sender encodes, in protobuf and JSON.
import { describe, expect, test } from "vitest";
import { decodeSpans } from "../src/otlp-decode.ts";
import { encodeSpans, type SpanRecord } from "../src/otlp.ts";

const spans: SpanRecord[] = [
  {
    traceId: "0af7651916cd43dd8448eb211c80319c",
    spanId: "b7ad6b7169203331",
    name: "nodrail.observation",
    start: "1763600000000000000",
    end: "1763600000000000000",
    attributes: {
      "nodrail.host": "codex",
      "nodrail.drift": "2",
      "nodrail.unmanaged.names": '["skill ünï (user)"]',
    },
  },
  {
    traceId: "0af7651916cd43dd8448eb211c80319c",
    spanId: "00000000000000ff",
    name: "nodrail.decision",
    start: "1",
    end: "18446744073709551615",
    attributes: {},
  },
];
const resource = { "service.name": "nodrail", "nodrail.project": "desk" };

describe("decodeSpans", () => {
  test.each(["otlp-http/protobuf", "otlp-http/json"] as const)(
    "reads back what %s sends",
    (protocol) => {
      const { body, contentType } = encodeSpans(spans, resource, protocol);
      expect(decodeSpans(body, contentType)).toEqual([{ resource, spans }]);
    },
  );

  test("bool and int values as text; other kinds skipped", () => {
    const body = new TextEncoder().encode(
      JSON.stringify({
        resourceSpans: [
          {
            scopeSpans: [
              {
                spans: [
                  {
                    name: "x",
                    attributes: [
                      { key: "a", value: { boolValue: true } },
                      { key: "b", value: { intValue: "7" } },
                      { key: "c", value: { arrayValue: { values: [] } } },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    expect(
      decodeSpans(body, "application/json")[0]!.spans[0]!.attributes,
    ).toEqual({ a: "true", b: "7" });
  });

  test.each([
    ["application/x-protobuf", Uint8Array.from([0x0a, 0x05, 0x01])],
    ["application/x-protobuf", Uint8Array.from([0x0b])],
    ["application/json", new TextEncoder().encode("{}")],
    ["application/json", new TextEncoder().encode("nope")],
    ["text/plain", new Uint8Array()],
  ])("%s that isn't an export throws", (type, body) => {
    expect(() => decodeSpans(body, type)).toThrow("not an OTLP trace export");
  });
});
