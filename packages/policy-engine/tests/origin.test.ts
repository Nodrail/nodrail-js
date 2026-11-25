import { expect, test } from "vitest";
import { canonicalOrigin } from "../src/control-plane-origin.ts";

test.each([
  ["HTTPS://Example.COM:443/", "https://example.com"],
  ["http://localhost:80/", "http://localhost"],
  ["https://example.com:8443", "https://example.com:8443"],
])("canonicalizes %s", (url, expected) => {
  expect(canonicalOrigin(url)).toBe(expected);
});

test.each([
  "file:///tmp",
  "ftp://example.com",
  "https://user:secret@example.com",
  "https://example.com/path",
  "https://example.com/?q=",
  "https://example.com/#fragment",
])("refuses non-origin input %s", (url) => {
  expect(() => canonicalOrigin(url)).toThrow();
});
