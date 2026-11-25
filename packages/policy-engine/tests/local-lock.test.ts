import * as fs from "node:fs";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  acquireLocalLock,
  processAlive,
  withProcessLock,
} from "../src/local-lock.ts";

let io: { fs: typeof fs; kill: typeof process.kill };

let folder: string;
beforeEach(() => {
  io = { fs: { ...fs }, kill: process.kill.bind(process) };
  folder = mkdtempSync(join(tmpdir(), "nodrail-lease-"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(folder, { force: true, recursive: true });
});

test("heartbeat renews a long-lived lease and releasing it stops renewal", () => {
  vi.useFakeTimers();
  const directory = join(folder, "lock");
  // Use the simulated wall clock for every filesystem heartbeat timestamp.
  const lock = acquireLocalLock(directory, { io });
  const [marker] = readdirSync(directory);
  const initial = new Date();
  utimesSync(join(directory, marker!), initial, initial);
  vi.advanceTimersByTime(35_000);
  expect(() => acquireLocalLock(directory, { io })).toThrow("Another nodrail");
  expect(lock.commit(() => "saved")).toBe("saved");
  lock.release();
  lock.release();
  expect(vi.getTimerCount()).toBe(0);
});

test("an expired lease cannot commit and another live commit guard postpones reclaim", () => {
  const directory = join(folder, "lock");
  const first = acquireLocalLock(directory, { io });
  const [marker] = readdirSync(directory);
  const age = () => utimesSync(join(directory, marker!), 1, 1);
  age();
  try {
    expect(() => first.commit(() => "stale")).toThrow(
      "local write lock expired",
    );
    withProcessLock(`${directory}.commit`, () => {
      expect(() => acquireLocalLock(directory, { io })).toThrow(
        "Another nodrail",
      );
    });
    const second = acquireLocalLock(directory, { io });
    try {
      expect(() => first.renew()).toThrow("local write lock expired");
      expect(second.commit(() => "current")).toBe("current");
    } finally {
      second.release();
    }
  } finally {
    first.release();
  }
});

test("process-owned locks only reclaim dead owners and preserve malformed markers", () => {
  const directory = join(folder, "lock");
  mkdirSync(directory);
  const malformed = join(directory, "unrecognized");
  writeFileSync(malformed, "");
  expect(() => withProcessLock(directory, () => undefined)).toThrow(
    "Another nodrail",
  );
  rmSync(malformed);
  const pid = 42;
  writeFileSync(join(directory, `${pid}-deadbeef`), "");
  vi.spyOn(io, "kill").mockImplementation((target) => {
    expect(target).toBe(pid);
    throw Object.assign(new Error("terminated"), { code: "ESRCH" });
  });
  expect(withProcessLock(directory, () => "recovered", io)).toBe("recovered");
});

const errno = (code: string) => Object.assign(new Error(code), { code });

function expiredMarker(directory: string) {
  mkdirSync(directory);
  const marker = join(directory, `${process.pid}-deadbeef`);
  writeFileSync(marker, "");
  utimesSync(marker, 1, 1);
  return marker;
}

test("an expired heartbeat cannot bring ownership back to life", () => {
  vi.useFakeTimers();
  const directory = join(folder, "lock");
  const held = acquireLocalLock(directory, { io });
  const [marker] = readdirSync(directory);
  utimesSync(join(directory, marker!), 1, 1);
  vi.advanceTimersByTime(5_000);
  try {
    expect(() => held.renew()).toThrow("local write lock expired");
  } finally {
    held.release();
  }
});

test.each(["directory", "marker", "unlink"])(
  "reclaim survives a competing release during %s inspection",
  (when) => {
    const directory = join(folder, "lock");
    const marker = expiredMarker(directory);
    if (when === "directory")
      vi.spyOn(io.fs, "readdirSync").mockImplementationOnce(() => {
        rmSync(directory, { recursive: true });
        throw errno("ENOENT");
      });
    if (when === "marker")
      vi.spyOn(io.fs, "statSync").mockImplementationOnce(() => {
        rmSync(marker);
        return undefined as never;
      });
    if (when === "unlink")
      vi.spyOn(io.fs, "unlinkSync").mockImplementationOnce(() => {
        rmSync(marker);
        throw errno("ENOENT");
      });
    const held = acquireLocalLock(directory, { io });
    try {
      expect(held.commit(() => "acquired")).toBe("acquired");
    } finally {
      held.release();
    }
  },
);

test.each([true, false])(
  "reclaim leaves a replacement marker alone even if expired is %s",
  (expired) => {
    const directory = join(folder, "lock");
    const marker = expiredMarker(directory);
    const replacement = join(directory, `${process.pid}-beefdead`);
    const firstObservation = fs.statSync(marker);
    vi.spyOn(io.fs, "statSync").mockImplementationOnce(() => {
      rmSync(marker);
      writeFileSync(replacement, "");
      if (expired) utimesSync(replacement, 1, 1);
      return firstObservation;
    });
    expect(() => acquireLocalLock(directory, { io })).toThrow(
      "Another nodrail",
    );
    expect(readdirSync(directory)).toEqual([`${process.pid}-beefdead`]);
  },
);

test("when another owner populates a released directory, cleanup preserves it", () => {
  const directory = join(folder, "lock");
  const lock = acquireLocalLock(directory, { io });
  vi.spyOn(io.fs, "rmdirSync").mockImplementationOnce(() => {
    writeFileSync(join(directory, "replacement"), "");
    throw errno("ENOTEMPTY");
  });
  lock.release();
  expect(readdirSync(directory)).toEqual(["replacement"]);
});

test("an unexpected claim error propagates and leaves no prepared directory", () => {
  const directory = join(folder, "lock");
  vi.spyOn(io.fs, "renameSync").mockImplementationOnce(() => {
    throw new Error("filesystem failure");
  });
  expect(() => acquireLocalLock(directory, { io })).toThrow(
    "filesystem failure",
  );
  expect(readdirSync(folder)).toEqual([]);
});

test.each(["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"])(
  "a claim blocked with %s checks the owner and can reclaim a stale lock",
  (code) => {
    const directory = join(folder, "lock");
    expiredMarker(directory);
    vi.spyOn(io.fs, "renameSync").mockImplementationOnce(() => {
      throw errno(code);
    });
    const lock = acquireLocalLock(directory, { io });
    try {
      expect(lock.commit(() => "saved")).toBe("saved");
    } finally {
      lock.release();
    }
  },
);

test("an inaccessible process still owns its lock", () => {
  const kill = vi.fn<typeof process.kill>(() => {
    throw errno("EPERM");
  });
  expect(processAlive(42, kill)).toBe(true);
  expect(kill).toHaveBeenCalledWith(42, 0);
});
