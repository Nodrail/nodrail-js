// The file contracts of tests/fixtures/files/nodrail.yaml, compiled the way
// a workspace compiles them, and fixture files by artifact.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { expect } from "vitest";
import { fileContracts, type FileContract } from "../../src/files/index";
import { compileContracts } from "../../src/shapes/index";

export const FIXTURES = join(import.meta.dirname, "../fixtures/files");

const agent = (name: string) => ({
  apiVersion: "nodrail.com/v1alpha1",
  kind: "Agent",
  metadata: { name },
  spec: {},
});

export function compiledFileContracts(): FileContract[] {
  const manifest: unknown = parse(
    readFileSync(join(FIXTURES, "nodrail.yaml"), "utf8"),
  );
  const result = compileContracts({
    manifest,
    resources: [agent("scribe"), agent("architect")],
  });
  expect(result.issues).toEqual([]);
  return fileContracts(result.contracts!);
}

export const CONTRACTS = compiledFileContracts();

export const contract = (name: string) =>
  CONTRACTS.find((found) => found.name === name)!;

/** Every fixture of one artifact: `valid*.md` and `invalid-*.md`. */
export function fixtures(artifact: string) {
  const folder = join(FIXTURES, artifact);
  return readdirSync(folder)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => ({
      name,
      valid: name.startsWith("valid"),
      text: readFileSync(join(folder, name), "utf8"),
    }));
}

export const fixture = (artifact: string, name: string) =>
  readFileSync(join(FIXTURES, artifact, name), "utf8");
