// What a browser bundles from the engine must not reach Node's modules:
// the web app's YAML editor checks rules in the browser, and a production
// build fails on a `node:` import anywhere in that graph. Type imports
// don't count; they are gone once compiled.
import { readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { describe, expect, test } from "vitest";

const src = join(import.meta.dirname, "../src");
const imports = /^(import|export)(?!\s+type\b)[^;]*?\sfrom\s+"([^"]+)"/gms;

/** Every `node:` module the file reaches by value, with the path there. */
function nodeImports(
  file: string,
  seen = new Set<string>(),
  path: string[] = [],
): string[] {
  if (seen.has(file)) return [];
  seen.add(file);
  const found: string[] = [];
  for (const [, , spec] of readFileSync(file, "utf8").matchAll(imports)) {
    if (spec!.startsWith("node:"))
      found.push([...path, file.slice(src.length + 1), spec].join(" → "));
    else if (spec!.startsWith("."))
      found.push(
        ...nodeImports(normalize(join(dirname(file), spec!)), seen, [
          ...path,
          file.slice(src.length + 1),
        ]),
      );
  }
  return found;
}

describe("browser entries", () => {
  test.each([
    "compile.ts",
    "simulator.ts",
    "index.ts",
    "shapes/index.ts",
    "shapes/values.ts",
  ])("%s reaches no node: module", (entry) => {
    expect(nodeImports(join(src, entry))).toEqual([]);
  });

  test("the check sees one when it is there", () => {
    expect(nodeImports(join(src, "yaml.ts")).length).toBeGreaterThan(0);
  });
});
