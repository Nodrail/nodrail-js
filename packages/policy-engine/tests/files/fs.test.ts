// The thin file-system adapter: current files read without following links,
// anything that could make the checked file differ from the written one
// refused, and the answer still preflight-only.
import { createHash } from "node:crypto";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, toNamespacedPath } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import {
  checkWriteOnDisk,
  FILE_LIMITS,
  readCurrentFile,
} from "../../src/files/index";
import { CONTRACTS, fixture } from "./support";

const base = mkdtempSync(join(tmpdir(), "nodrail-files-"));
const root = join(base, "project");
const outside = join(base, "outside");
const alias = join(base, "alias");
afterAll(() => rmSync(base, { recursive: true, force: true }));

const put = (path: string, content: string | Buffer) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
};

put(join(root, "docs/adr/1.md"), fixture("adr", "valid.md"));
put(join(outside, "secret.md"), "secret\n");
put(join(root, "big.md"), Buffer.alloc(FILE_LIMITS.maxBytes + 1, 0x61));
symlinkSync(join(outside, "secret.md"), join(root, "docs/adr/link.md"));
mkdirSync(join(root, "memory"));
symlinkSync(join(root, "docs/adr"), join(root, "memory/adr"), "junction");
symlinkSync(outside, join(root, "escape"), "junction");
symlinkSync(root, alias, "junction");
linkSync(join(outside, "secret.md"), join(root, "hard.md"));
mkdirSync(join(root, "folder.md"));

describe("reading current files", () => {
  test("a regular file, with its revision over the bytes", () => {
    const found = readCurrentFile(root, "docs/adr/1.md");
    const bytes = Buffer.from(fixture("adr", "valid.md"));
    expect(found).toEqual({
      state: "present",
      content: new Uint8Array(bytes),
      revision: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    });
  });

  test.each([
    ["docs/adr/missing.md", { state: "absent" }],
    ["nowhere/at/all.md", { state: "absent" }],
    [
      "../outside/secret.md",
      { state: "unsafe", reason: "isn't a normalized project-relative path" },
    ],
    ["docs/adr/1.md/below.md", { state: "absent" }],
    [
      "docs/adr/link.md",
      { state: "unsafe", reason: "is reached through a symlink" },
    ],
    [
      "memory/adr/1.md",
      { state: "unsafe", reason: "is reached through a symlink" },
    ],
    [
      "escape/secret.md",
      { state: "unsafe", reason: "is reached through a symlink" },
    ],
    ["hard.md", { state: "unsafe", reason: "has more than one hard link" }],
    ["folder.md", { state: "unsafe", reason: "isn't a regular file" }],
    [
      "big.md",
      { state: "unsafe", reason: `is over ${FILE_LIMITS.maxBytes} bytes` },
    ],
  ])("%s", (path, expected) => {
    expect(readCurrentFile(root, path)).toEqual(expected);
  });

  test("a missing project folder is unsafe", () => {
    expect(readCurrentFile(join(base, "nope"), "a.md")).toMatchObject({
      state: "unsafe",
    });
  });

  test("the reader requires the normalized spelling of a project path", () => {
    expect(readCurrentFile(root, "./docs/adr/1.md")).toEqual({
      state: "unsafe",
      reason: "isn't a normalized project-relative path",
    });
  });
});

describe("checking a write on disk", () => {
  const input = {
    projectRoot: root,
    cwd: root,
    contracts: CONTRACTS,
    agent: "scribe",
  };

  test.runIf(process.platform !== "win32")(
    "a double-slash POSIX root does not treat backslashes as separators",
    () => {
      const projectRoot = `/${root}`;
      const result = checkWriteOnDisk({
        ...input,
        projectRoot,
        cwd: projectRoot,
        request: {
          tool: "write",
          path: String.raw`docs\adr\1.md`,
          content: fixture("adr", "valid.md"),
        },
      });
      expect(result).toMatchObject({
        decision: "deny",
        reason: expect.stringContaining("backslash"),
      });
    },
  );

  test("an Edit of a real file is reconstructed and validated", () => {
    const result = checkWriteOnDisk({
      ...input,
      request: {
        tool: "edit",
        path: join(root, "docs/adr/1.md"),
        oldString: "status: accepted",
        newString: "status: superseded",
        replaceAll: false,
      },
    });
    expect(result).toMatchObject({
      decision: "allow",
      guarantee: "preflight-only",
      atomic: false,
    });
    expect(result.expected[0]!.revision).toMatch(/^sha256:/);
  });

  test("a write through a symlink into a contract folder is refused", () => {
    const result = checkWriteOnDisk({
      ...input,
      request: {
        tool: "write",
        path: join(root, "memory/adr/1.md"),
        content: "x",
      },
    });
    expect(result).toMatchObject({
      decision: "deny",
      files: [{ issues: [{ code: "unsafe-path" }] }],
    });
  });

  test("the resolved spelling of the project folder is still inside it", () => {
    const real = realpathSync.native(alias);
    const result = checkWriteOnDisk({
      ...input,
      projectRoot: alias,
      cwd: alias,
      request: {
        tool: "write",
        path: toNamespacedPath(join(real, "docs/adr/2.md")),
        content: "no sections\n",
      },
    });
    expect(result).toMatchObject({
      decision: "deny",
      files: [{ path: "docs/adr/2.md", contracts: ["adr"] }],
    });
    const missing = checkWriteOnDisk({
      ...input,
      projectRoot: join(base, "nope"),
      request: { tool: "write", path: join(base, "nope/a.md"), content: "x" },
    });
    expect(missing.decision).toBe("deny");
  });

  test("each file is read once per check", () => {
    const result = checkWriteOnDisk({
      ...input,
      request: {
        tool: "write",
        path: join(root, "docs/adr/1.md"),
        content: fixture("adr", "valid.md"),
      },
    });
    expect(result.decision).toBe("allow");
    expect(result.expected).toEqual([
      { path: "docs/adr/1.md", state: "present", revision: expect.any(String) },
    ]);
  });
});
