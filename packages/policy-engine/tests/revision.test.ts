// The revision a clean checkout is at can be computed from its commit alone,
// so CI evidence for a commit ties to the exact local subject.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { cleanRevision, workRevision } from "../src/revision";

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0))
    rmSync(folder, { recursive: true, force: true });
});

function repository() {
  const folder = mkdtempSync(join(tmpdir(), "nodrail-revision-"));
  folders.push(folder);
  const git = (...args: string[]) =>
    spawnSync("git", args, { cwd: folder, encoding: "utf8" }).stdout.trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(folder, "a.txt"), "one\n");
  git("add", "a.txt");
  git("commit", "-q", "-m", "one");
  return { folder, head: () => git("rev-parse", "HEAD") };
}

describe("cleanRevision", () => {
  test("equals workRevision on a clean checkout of that commit", () => {
    const { folder, head } = repository();
    expect(workRevision(folder)).toMatch(/^sha256:/);
    expect(workRevision(folder)).toBe(cleanRevision(head()));
  });

  test("an untracked file or a tracked change makes the work differ from the commit", () => {
    const { folder, head } = repository();
    writeFileSync(join(folder, "b.txt"), "new\n");
    const untracked = workRevision(folder);
    // Read, not unknown: untracked files are hashed by content.
    expect(untracked).toMatch(/^sha256:/);
    expect(untracked).not.toBe(cleanRevision(head()));
    writeFileSync(join(folder, "b.txt"), "newer\n");
    expect(workRevision(folder)).toMatch(/^sha256:/);
    expect(workRevision(folder)).not.toBe(untracked);
    rmSync(join(folder, "b.txt"));
    writeFileSync(join(folder, "a.txt"), "two\n");
    expect(workRevision(folder)).not.toBe(cleanRevision(head()));
  });

  test("a folder below the top reads the whole work tree's revision", () => {
    const { folder } = repository();
    mkdirSync(join(folder, "sub"));
    writeFileSync(join(folder, "sub", "new.txt"), "in sub\n");
    writeFileSync(join(folder, "top.txt"), "at top\n");
    const whole = workRevision(folder);
    expect(whole).toMatch(/^sha256:/);
    expect(workRevision(join(folder, "sub"))).toBe(whole);
    // An untracked file outside the folder still counts.
    rmSync(join(folder, "top.txt"));
    expect(workRevision(join(folder, "sub"))).not.toBe(whole);
  });

  test("only a full lowercase commit id has a revision", () => {
    expect(cleanRevision("abc123")).toBeNull();
    expect(cleanRevision("A".repeat(40))).toBeNull();
    expect(cleanRevision(`${"a".repeat(40)}\n`)).toBeNull();
    expect(cleanRevision("a".repeat(40))).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(cleanRevision("a".repeat(64))).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
