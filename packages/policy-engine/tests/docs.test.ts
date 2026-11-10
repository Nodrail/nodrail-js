import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { compilePolicies } from "../src/yaml";

const root = new URL("..", import.meta.url).pathname;
const pages = [
  "README.md",
  "SECURITY.md",
  ...readdirSync(join(root, "docs")).map((file) => `docs/${file}`),
];
const read = (page: string) => readFileSync(join(root, page), "utf8");

const blocks = (text: string, language: string) =>
  [...text.matchAll(/^```([^\n]*)\n([\s\S]*?)^```$/gm)]
    .filter(([, info]) => info === language)
    .map(([, , body]) => body ?? "");

describe.each(pages)("%s", (page) => {
  test("its YAML examples are valid rules", () => {
    for (const body of blocks(read(page), "yaml")) {
      // A cases file is a list too, but of expected outcomes.
      if (/^- name:/m.test(body)) continue;
      const result = compilePolicies([{ name: page, text: body }]);
      expect(result.ok ? [] : result.issues).toEqual([]);
    }
  });

  test("its JSON examples parse", () => {
    for (const body of blocks(read(page), "json"))
      expect(() => JSON.parse(body) as unknown).not.toThrow();
  });

  test("its links point at something that exists", () => {
    for (const [, target = ""] of read(page).matchAll(
      /\]\((?!http|mailto)([^)#]+)/g,
    ))
      expect(
        existsSync(resolve(dirname(join(root, page)), target)),
        target,
      ).toBe(true);
  });
});
