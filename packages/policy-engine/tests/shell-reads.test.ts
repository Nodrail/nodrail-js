// Shell commands that only read are judged as the file reads they are, as
// Codex makes them, beside the command itself: the stricter decision wins.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { compiled } from "./support/compiled";
import { decideToolCall } from "../src/local-hook";
import { starterPacks } from "../src/yaml";

const project = mkdtempSync(join(tmpdir(), "nodrail-reads-"));
mkdirSync(join(project, "src"));
writeFileSync(join(project, "src/sum.js"), "export const sum = 1;\n");

const readOnly = compiled(starterPacks["read-only"].text);

/** What the hook answers for this command run in the project. */
function hook(command: string, document = readOnly) {
  const { stdout } = decideToolCall(
    JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command },
      cwd: project,
    }),
    { document, now: new Date("2026-11-18T00:00:00Z"), unmatched: "deny" },
  );
  return stdout === "" ? "allow" : stdout;
}

describe("reads Codex makes through its shell", () => {
  test.each([
    "cat src/sum.js",
    "sed -n '1,120p' src/sum.js",
    "sed -n 5p src/sum.js",
    "head -n 20 src/sum.js",
    "tail -50 src/sum.js",
    "nl -ba src/sum.js",
    "wc -l src/sum.js",
    "grep -n sum src/sum.js",
    "rg -n sum src",
    "rg --files",
    "rg -n 'su.*m' src",
    "rg -g '*.js' sum",
    "ls -la src",
    // Several files named one by one: each is a read, as Codex batches them.
    "cat src/sum.js src/other.js",
    "head -n 5 src/sum.js src/other.js",
  ])("%s is judged as a read, and the read-only pack allows it", (command) => {
    expect(hook(command)).toBe("allow");
  });

  test.each([
    "cat .env",
    "sed -n '1p' .env",
    "head -n 5 config/.env.local",
    "rg token .env",
    "rg -g '.env*' token",
    "ls .ssh",
    // One secret among several files denies them all.
    "cat src/sum.js .env",
  ])("%s reaches a secret and is denied", (command) => {
    expect(hook(command)).toContain('"deny"');
  });

  test.each([
    // The shell expands these first: the word isn't the path it looks like.
    "ls .en?",
    "cat src/*.js",
    "cat ~/notes.txt",
    "rg sum.* src",
    // Shapes that read more than they say, or do more than read.
    "rg --hidden token",
    "rg -u token",
    "grep -rn token .",
    "tail -f src/sum.js",
    "sed -n '1p;w out' src/sum.js",
    "cat src/sum.js | head",
    `cat ${Array.from({ length: 21 }, () => "src/sum.js").join(" ")}`,
  ])("%s is left a shell command, which the pack doesn't allow", (command) => {
    expect(hook(command)).toContain('"deny"');
  });
});

describe("the command's own rules keep their meaning", () => {
  test("a rule against cat still holds when reads are allowed", () => {
    const document = compiled(`- rule: Read anything
  tool: files
  operation: file.read
  resource: { kind: file, match: any }
  effect: allow
- rule: Never cat
  command: { prefix: cat }
  effect: deny
`);
    expect(hook("cat src/sum.js", document)).toContain("never-cat");
    expect(hook("head src/sum.js", document)).toBe("allow");
  });

  test("a rule allowing ls still allows it with no read rule", () => {
    const document = compiled(`- rule: Look around
  command: ls
  effect: allow
`);
    expect(hook("ls", document)).toBe("allow");
  });
});
