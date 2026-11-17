// `nodrail policy` is nodrail-policy: every command answers the same bytes on
// stdout and stderr, and the same exit code. The packed bin is compared with
// the installed nodrail-policy in scripts/verify-pack.mjs.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { policy } from "../src/commands/policy.ts";
import { cli as nodrailPolicy } from "../../policy-engine/tests/run-cli.ts";
import { fakeIo } from "./support/fake-io.ts";

const examples = new URL("../../policy-engine/examples/", import.meta.url);
const rules = new URL("rules", examples).pathname;
const cases = new URL("cases.yaml", examples).pathname;
const folder = mkdtempSync(join(tmpdir(), "nodrail-policy-"));
const broken = join(folder, "broken.yaml");
writeFileSync(broken, "- rule: Nothing else\n");

/** Runs one command line through both commands and expects the same result. */
async function same(args: string[], stdin = "") {
  const expected = await nodrailPolicy(args, stdin);
  const t = fakeIo({ stdin });
  const code = await t.run("policy", ...args);
  expect({ code, ...t.bytes() }).toEqual(expected);
  return expected;
}

describe("nodrail policy matches nodrail-policy", () => {
  test("help, version and usage errors", async () => {
    expect((await same(["--help"])).stdout).toContain("Usage:");
    expect((await same(["--version"])).code).toBe(0);
    expect((await same([])).code).toBe(2);
    expect((await same(["frobnicate", rules])).code).toBe(2);
    expect((await same(["validate", rules, "--nope"])).code).toBe(2);
  });

  test("init", async () => {
    expect((await same(["init", "repo-work"])).stdout).toContain("- rule:");
    expect((await same(["init", "nope"])).code).toBe(2);
  });

  test("validate", async () => {
    expect((await same(["validate", rules])).stdout).toMatch(/^OK/);
    expect((await same(["validate", broken])).code).toBe(1);
    const missing = await same(["validate", join(folder, "missing.yaml")]);
    expect(missing.stderr).toContain("ENOENT");
  });

  test("compile", async () => {
    expect(JSON.parse((await same(["compile", rules])).stdout)).toMatchObject({
      version: 1,
    });
  });

  test("eval", async () => {
    const shell = await same(["eval", rules, "--command", "git status"]);
    expect(shell.stdout).toContain('"outcome": "allow"');
    const call = await same([
      "eval",
      rules,
      "--tool=github",
      "--operation=repositories.delete",
      "--kind=repository",
      "--resource=acme/app",
      "--now=2026-01-01T00:00:00Z",
    ]);
    expect(call.stdout).toContain('"outcome": "deny"');
    expect((await same(["eval", rules])).code).toBe(2);
  });

  test("test --cases", async () => {
    expect((await same(["test", rules, "--cases", cases])).code).toBe(0);
    expect((await same(["test", broken, "--cases", cases])).code).toBe(1);
    expect((await same(["test", rules])).code).toBe(2);
  });

  test("check and exec", async () => {
    expect((await same(["check", rules, "--", "git", "status"])).code).toBe(0);
    const pushed = ["--", "git", "push", "--force"];
    expect((await same(["check", rules, ...pushed])).code).toBe(1);
    expect((await same(["exec", rules, ...pushed])).code).toBe(126);
    expect((await same(["check", rules])).code).toBe(2);
  });
});

const event = (command: string) =>
  JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
  });

describe("nodrail policy hook answers Claude Code like nodrail-policy hook", () => {
  test.each([
    ["an allowed call", event("git status")],
    ["a denied call", event("git push --force origin main")],
    ["a call no rule covers", event("curl example.com")],
    ["an event that is not JSON", "{"],
  ])("%s", async (_, stdin) => {
    await same(["hook", rules], stdin);
    await same(["hook", rules, "--unmatched", "ask"], stdin);
  });

  test("rules that cannot load block with 2", async () => {
    expect((await same(["hook", broken], event("ls"))).code).toBe(2);
    const missing = join(folder, "missing.yaml");
    expect((await same(["hook", missing], event("ls"))).code).toBe(2);
  });
});

describe("nodrail policy's own subcommands", () => {
  test("are dispatched by name, before nodrail-policy's", async () => {
    const t = fakeIo();
    const seen: string[][] = [];
    const own = new Map([
      [
        "lock",
        async (args: string[]) => {
          seen.push(args);
          return 0;
        },
      ],
    ]);
    expect(await policy(["lock", "--frozen"], t.io, own)).toBe(0);
    expect(seen).toEqual([["--frozen"]]);
    expect(await policy(["validate", rules], t.io, own)).toBe(0);
    expect(t.stdout()).toMatch(/^OK/);
  });

  test("nodrail --help lists them", async () => {
    const t = fakeIo();
    expect(await t.run("--help")).toBe(0);
    expect(t.stdout()).toContain("Policies (offline, no account)");
    expect(t.stdout()).toContain("policy hook");
  });
});
