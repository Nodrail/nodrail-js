import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
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

describe("the getting-started walkthrough", () => {
  const cli = (args: string[], input?: string) =>
    spawnSync(
      process.execPath,
      ["--import", "tsx", join(root, "src/cli.ts"), ...args],
      { encoding: "utf8", input },
    );
  const guide = read("docs/getting-started.md");
  const folder = mkdtempSync(join(tmpdir(), "nodrail-guide-"));
  const rules = join(folder, "rules.yaml");
  writeFileSync(rules, blocks(guide, "yaml")[0] ?? "");

  test("its policy decides the three commands as its table says", () => {
    expect(cli(["validate", rules]).stdout).toMatch(/^OK\b.*\b2 rules\./);
    for (const [command, outcome] of [
      ["git status", "allow"],
      ["git clean -fd", "deny"],
      ["git log", "none"],
    ] as const) {
      expect(guide).toContain(`| \`${command}\` | \`${outcome}\` |`);
      const result = cli(["eval", rules, "--command", command]);
      expect(JSON.parse(result.stdout)).toMatchObject({ outcome });
    }
  });

  test("its CI cases pass against its policy", () => {
    const cases = join(folder, "cases.yaml");
    const section = guide.slice(guide.indexOf("## Test your rules in CI"));
    writeFileSync(cases, blocks(section, "yaml")[0] ?? "");
    const result = cli(["test", rules, "--cases", cases]);
    expect(result.stdout + result.stderr).toContain("3 of 3 passed.");
    expect(result.status).toBe(0);
  });

  test("its hook example denies the unmatched command", () => {
    const [event] = /'(\{"hook_event_name".*?\})'/.exec(guide) ?? [];
    expect(event).toBeDefined();
    const result = cli(["hook", rules], event!.slice(1, -1));
    expect(JSON.parse(result.stdout)).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
  });
});

describe("the custom harness in the library guide", () => {
  const example = join(root, "examples/custom-harness");
  const guide = read("docs/library.md");
  const section = guide.slice(
    guide.indexOf("## Connect a custom harness"),
    guide.indexOf("## Rule files"),
  );

  test("shows the files in examples/custom-harness", () => {
    expect(blocks(section, "yaml")).toEqual([
      readFileSync(join(example, "rules.yaml"), "utf8"),
    ]);
    expect(blocks(section, "js")).toEqual([
      readFileSync(join(example, "demo.mjs"), "utf8"),
    ]);
  });

  test("runs with node and invokes only the allowed operation", () => {
    const result = spawnSync(process.execPath, [join(example, "demo.mjs")], {
      encoding: "utf8",
    });
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("allow deny [ 'inspect' ]\n");
  });

  test("its cases pass: allowed, denied and unmatched", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        join(root, "src/cli.ts"),
        "test",
        join(example, "rules.yaml"),
        "--cases",
        join(example, "cases.yaml"),
      ],
      { encoding: "utf8" },
    );
    expect(result.stdout + result.stderr).toContain("3 of 3 passed");
    expect(result.status).toBe(0);
  });
});
