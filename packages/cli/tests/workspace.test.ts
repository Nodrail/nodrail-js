// The reviewed workspace: a setup's lock records every file the hosts get,
// the agents' instructions and skills as well as the policy, under one
// digest that is the same on any machine. A policy alone keeps its lock.
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, test } from "vitest";
import { readLock, sha256, sourcesOf } from "../src/project/lockfile.ts";
import { workspaceDigest } from "../src/project/workspace.ts";
import { projectFolder } from "./support/project-folder.ts";
import { locked, RESOURCES } from "./support/setup-project.ts";

type LockFile = {
  lock: number;
  effective: { sha256: string };
  workspace?: { sha256: string; files: { path: string }[] };
};
const lockOf = (p: { read: (path: string) => string }) =>
  parse(p.read("nodrail.lock.yaml")) as LockFile;

const checkLine = (out: string, name: string) =>
  out.split("\n").find((line) => line.includes(` ${name}: `)) ?? "";

describe("a setup's lock", () => {
  test("records the instructions and every skill file, with one digest", async () => {
    const p = await locked();
    const lock = lockOf(p);
    expect(lock.lock).toBe(2);
    expect(lock.workspace!.files.map((file) => file.path)).toEqual([
      "resources/lead.md",
      "skills/release-notes/SKILL.md",
      "skills/release-notes/template.md",
    ]);
    expect(lock.workspace!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(checkLine((await p.run("plan")).out, "workspace")).toContain(
      `✓ workspace: matches nodrail.lock.yaml (${lock.workspace!.sha256.slice(0, 12)})`,
    );
  });

  test("covers the effective policy, so another engine's policy is another revision", async () => {
    const p = await locked();
    const lock = readLock(p.read("nodrail.lock.yaml"));
    if (typeof lock === "string") throw new Error(lock);
    const content = lock.workspace!.files;
    const digest = (effective: string) =>
      workspaceDigest(
        sourcesOf({ ...lock, effective: { sha256: effective } }, content),
        sha256,
      );
    // The same files, compiled to another policy, as another engine might.
    expect(digest(lock.effective!.sha256)).toBe(lock.workspace!.sha256);
    expect(digest("0".repeat(64))).not.toBe(lock.workspace!.sha256);
  });

  test("is the same in another folder, so a copy has the same digests", async () => {
    const [a, b] = [await locked(), await locked()];
    expect(a.cwd).not.toBe(b.cwd);
    expect(a.read("nodrail.lock.yaml")).toBe(b.read("nodrail.lock.yaml"));
  });

  test.each([
    [
      "editing instructions",
      (cwd: string) => writeFileSync(join(cwd, "resources/lead.md"), "Lead.\n"),
      "~ resources/lead.md",
    ],
    [
      "editing a skill's support file",
      (cwd: string) =>
        writeFileSync(join(cwd, "skills/release-notes/template.md"), "x\n"),
      "~ skills/release-notes/template.md",
    ],
    [
      "adding a skill file",
      (cwd: string) =>
        writeFileSync(join(cwd, "skills/release-notes/new.md"), "x\n"),
      "+ skills/release-notes/new.md",
    ],
    [
      "removing a skill file",
      (cwd: string) => rmSync(join(cwd, "skills/release-notes/template.md")),
      "- skills/release-notes/template.md",
    ],
  ])("%s stops plan and apply, naming the file", async (_, change, named) => {
    const p = await locked();
    change(p.cwd);
    const plan = await p.run("plan");
    expect(plan.code).toBe(1);
    expect(checkLine(plan.out, "policy")).toContain("✓ policy: matches");
    expect(checkLine(plan.out, "workspace")).toContain(
      `! workspace: changed since it was locked: ${named}. Run \`nodrail policy lock\` to review it.`,
    );
    expect((await p.run("apply", "--yes")).code).toBe(1);
    // The policy is unchanged, so its export still works.
    expect((await p.run("policy", "export", "--frozen")).code).toBe(0);
    const relock = await p.run("policy", "lock");
    expect(relock.out).toContain(
      `Instructions, skills and plugins, compared with the lock:\n  ${named}`,
    );
    expect((await p.run("plan")).code).toBe(0);
  });

  test("a lock from before workspaces is upgraded by locking again, never silently", async () => {
    const p = await locked();
    const lock = lockOf(p);
    const old = p
      .read("nodrail.lock.yaml")
      .replace("lock: 2", "lock: 1")
      .replace(/workspace:\n(?: {2}.*\n)+/, "");
    expect(readLock(old)).not.toBeTypeOf("string");
    writeFileSync(join(p.cwd, "nodrail.lock.yaml"), old);
    expect((await p.run("policy", "export", "--frozen")).code).toBe(0);
    const plan = await p.run("plan");
    expect(plan.code).toBe(1);
    expect(checkLine(plan.out, "workspace")).toContain(
      "! workspace: nodrail.lock.yaml records the policy only. Run `nodrail policy lock` to record the agents' instructions and skills too, and commit it.",
    );
    const relock = await p.run("policy", "lock");
    expect(relock.out).toContain(
      "Workspace: now records 3 instruction, skill and plugin files",
    );
    expect(lockOf(p).workspace!.sha256).toBe(lock.workspace!.sha256);
  });
});

describe("a policy alone", () => {
  test("keeps its lock format, with no workspace", async () => {
    const p = projectFolder({
      "nodrail.yaml":
        "kind: nodrail.project/v1\nimports:\n  - ./policies/base.yaml\n",
      "policies/base.yaml": RESOURCES["policies/base.yaml"],
    });
    expect((await p.run("policy", "lock")).code).toBe(0);
    expect(lockOf(p).lock).toBe(1);
    expect(lockOf(p).workspace).toBeUndefined();
  });
});

describe("reading a lock", () => {
  test("a newer format asks for a newer nodrail", () => {
    expect(readLock("lock: 3\n")).toBe(
      "nodrail.lock.yaml uses lock format 3; this nodrail reads 1 and 2. Update nodrail.",
    );
  });

  test("a format and its workspace go together", async () => {
    const p = await locked();
    expect(
      readLock(p.read("nodrail.lock.yaml").replace("lock: 2", "lock: 1")),
    ).toBe("nodrail.lock.yaml is damaged");
  });
});
