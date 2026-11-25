import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { posix, resolve, win32 } from "node:path";
import { expect, test, vi } from "vitest";
import { fullPath, insideAll, isWithin, isWithinOnDisk } from "../src/paths";

vi.mock("node:fs", { spy: true });

test("rejects a relative name whose resolved path would be too deep", () => {
  const cwd = resolve(tmpdir(), "parent", "project");
  expect(fullPath("file.txt", cwd)).not.toBeNull();
  expect(fullPath(`${"dir/".repeat(255)}file.txt`, cwd)).toBeNull();
});

test("paths cannot satisfy an inside-cwd rule when the working folder is unknown", () => {
  expect(insideAll([resolve(tmpdir(), "file.txt")], null)).toEqual({});
});

test.each([
  ["c:/PROJECT/src/a.ts", String.raw`C:\project`, true],
  [String.raw`\\?\C:\project\src\a.ts`, "c:/project/", true],
  [String.raw`\\?\UNC\host\share\project\a.ts`, "//HOST/share/project", true],
  [String.raw`\\host\other\project\a.ts`, "//host/share/project", false],
  ["D:/project/a.ts", "C:/project", false],
  ["C:/project-other/a.ts", "C:/project", false],
  ["C:/project/../a.ts", "C:/project", false],
])("Windows containment for %s under %s is %s", (path, root, expected) => {
  expect(isWithin(path, root, win32)).toBe(expected);
});

test.each([
  ["/project/a.ts", "/project/", true],
  ["/project", "/project", true],
  ["/project-other/a.ts", "/project", false],
  ["/PROJECT/a.ts", "/project", false],
  [String.raw`/project\elsewhere`, "/project", false],
])("POSIX containment for %s under %s is %s", (path, root, expected) => {
  expect(isWithin(path, root, posix)).toBe(expected);
});

test.each([
  { path: "c:/PROJECT/new.ts", dev: 1n, ino: 10n, expected: true },
  { path: "c:/PROJECT/src/new.ts", dev: 1n, ino: 10n, expected: true },
  { path: "c:/PROJECT/src/new.ts", dev: 1n, ino: 11n, expected: false },
  { path: "c:/PROJECT/src/new.ts", dev: 2n, ino: 10n, expected: false },
])(
  "Windows authorization of $path checks the project boundary ($dev, $ino)",
  ({ path, dev, ino, expected }) => {
    const project = { isDirectory: () => true, dev: 1n, ino: 10n };
    const stat = vi.mocked(fs.statSync);
    try {
      stat.mockImplementation((name) => {
        if (name === "c:\\PROJECT")
          return { ...project, dev, ino } as fs.BigIntStats;
        if (name === "C:/project") return project as fs.BigIntStats;
        throw Object.assign(new Error("Path does not exist"), {
          code: "ENOENT",
        });
      });
      expect(isWithinOnDisk(path, "C:/project", win32)).toBe(expected);
      expect(stat.mock.calls).toEqual([
        ["c:\\PROJECT", { bigint: true }],
        ["C:/project", { bigint: true }],
      ]);
    } finally {
      stat.mockReset();
    }
  },
);
