import { expect, test } from "vitest";
import { canonicalOrigin } from "../src/command-line";

test.each([
  ["https://Nodrail.Example:443/", "https://nodrail.example"],
  ["https://nodrail.example:8443", "https://nodrail.example:8443"],
  ["http://LOCALHOST:80/", "http://localhost"],
  ["http://127.0.0.1:3010", "http://127.0.0.1:3010"],
  ["http://[::1]:80", "http://[::1]"],
])("normalizes %s for an enrollment and hook to share", (url, origin) => {
  expect(canonicalOrigin(url)).toBe(origin);
});

test.each([
  ["https://", "is not a URL"],
  ["ftp://nodrail.example", "is not a URL"],
  ["http://nodrail.example", "must be reached over https"],
  ["https://user@example.test", "without a path or sign-in details"],
  ["https://nodrail.example/path", "without a path or sign-in details"],
  ["https://nodrail.example/?query=1", "without a path or sign-in details"],
  ["https://nodrail.example/#fragment", "without a path or sign-in details"],
])("refuses %s before a hook can use a credential", (url, reason) => {
  expect(() => canonicalOrigin(url)).toThrow(reason);
});
