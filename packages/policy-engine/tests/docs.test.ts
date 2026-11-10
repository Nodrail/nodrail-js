import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { compilePolicies } from "../src/yaml";

const root = fileURLToPath(new URL("..", import.meta.url));
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

test("the pages have examples to check, so the tests above can't pass empty", () => {
  expect(blocks(read("README.md"), "yaml").length).toBeGreaterThan(0);
  expect(blocks(read("docs/rules.md"), "yaml").length).toBeGreaterThan(0);
});

test("the getting-started CI example passes against the pack it starts from", () => {
  const cli = (...args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", join(root, "src/cli.ts"), ...args], {
      encoding: "utf8",
    });
  const folder = mkdtempSync(join(tmpdir(), "nodrail-guide-"));
  const rules = join(folder, "rules.yaml");
  const cases = join(folder, "cases.yaml");
  writeFileSync(rules, cli("init", "repo-work").stdout);
  const guide = read("docs/getting-started.md");
  const section = guide.slice(guide.indexOf("## Test your rules in CI"));
  writeFileSync(cases, blocks(section, "yaml")[0] ?? "");
  const result = cli("test", rules, "--cases", cases);
  expect(result.stdout + result.stderr).toContain("2 of 2 passed");
  expect(result.status).toBe(0);
});
