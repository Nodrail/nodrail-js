import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { dirname, join } from "node:path";

const native = { fs, kill: process.kill.bind(process) };
type LockIO = {
  fs: Pick<
    typeof fs,
    | "mkdirSync"
    | "mkdtempSync"
    | "readdirSync"
    | "renameSync"
    | "rmdirSync"
    | "rmSync"
    | "statSync"
    | "unlinkSync"
    | "utimesSync"
    | "writeFileSync"
  >;
  kill: typeof process.kill;
};

const leaseMs = 30_000;

function errno(error: unknown) {
  return (error as NodeJS.ErrnoException).code;
}

export function processAlive(pid: number, kill = native.kill) {
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return errno(error) !== "ESRCH";
  }
}

function removeEmpty(folder: string, io: LockIO) {
  try {
    io.fs.rmdirSync(folder);
  } catch (error) {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(errno(error) ?? ""))
      throw error;
  }
}

/** Reclaim only the marker observed. A replacement always arrives nonempty. */
function observedStale(folder: string, leased: boolean, io: LockIO) {
  let names: string[];
  try {
    names = io.fs.readdirSync(folder);
  } catch (error) {
    if (errno(error) === "ENOENT") return true;
    throw error;
  }
  if (names.length) {
    const [name] = names;
    const owner = /^([1-9][0-9]*)-[a-f0-9-]+$/.exec(name ?? "");
    if (names.length !== 1 || !owner) return false;
    const marker = join(folder, name!);
    const state = io.fs.statSync(marker, { throwIfNoEntry: false });
    if (!state) return true;
    if (
      processAlive(Number(owner[1]), io.kill) &&
      (!leased || Date.now() - state.mtimeMs < leaseMs)
    )
      return false;
    return marker;
  }
  return true;
}

function reclaim(folder: string, leased: boolean, io: LockIO) {
  const stale = observedStale(folder, leased, io);
  if (!stale) return false;
  // Recheck under the same guard used for committing a staged write. The
  // first observation keeps contenders off the guard while the lease is live.
  const clear = () => {
    const current = observedStale(folder, leased, io);
    if (!current || (typeof current === "string" && current !== stale))
      return false;
    if (typeof current === "string") {
      try {
        io.fs.unlinkSync(current);
      } catch (error) {
        if (errno(error) !== "ENOENT") throw error;
      }
    }
    removeEmpty(folder, io);
    return true;
  };
  if (!leased) return clear();
  try {
    return withProcessLock(`${folder}.commit`, clear, io);
  } catch (error) {
    if (error instanceof LocalLockBusy) return false;
    throw error;
  }
}

export class LocalLockBusy extends Error {}

export function withProcessLock<T>(
  folder: string,
  work: () => T,
  io: LockIO = native,
): T {
  const lock = acquireLocalLock(folder, { leased: false, io });
  try {
    return work();
  } finally {
    lock.release();
  }
}

/** Atomic instance publication and renewal by a marker whose name is never reused. */
export function acquireLocalLock(
  folder: string,
  { leased = true, io = native }: { leased?: boolean; io?: LockIO } = {},
) {
  io.fs.mkdirSync(dirname(folder), { recursive: true, mode: 0o700 });
  const prepared = io.fs.mkdtempSync(`${folder}.claim-`);
  const name = `${process.pid}-${randomUUID()}`;
  io.fs.writeFileSync(join(prepared, name), "", { flag: "wx", mode: 0o600 });
  const marker = join(folder, name);
  let acquired = false;
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        io.fs.renameSync(prepared, folder);
        acquired = true;
        break;
      } catch (error) {
        if (
          !["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes(
            errno(error) ?? "",
          )
        )
          throw error;
        if (!reclaim(folder, leased, io)) break;
      }
    }
    if (!acquired)
      throw new LocalLockBusy(
        "Another nodrail is changing this project or machine. Try again when it has finished.",
      );
  } finally {
    if (!acquired) {
      io.fs.rmSync(prepared, { recursive: true, force: true });
    }
  }

  function renew() {
    const state = io.fs.statSync(marker, { throwIfNoEntry: false });
    if (!state || (leased && Date.now() - state.mtimeMs >= leaseMs))
      throw new LocalLockBusy(
        "The local write lock expired. Run the command again.",
      );
    const now = new Date();
    io.fs.utimesSync(marker, now, now);
  }

  const heartbeat = leased
    ? setInterval(() => {
        try {
          renew();
        } catch {
          // The next operation will reject this expired instance.
        }
      }, 5_000).unref()
    : undefined;

  return {
    renew,
    commit<T>(write: () => T) {
      return withProcessLock(
        `${folder}.commit`,
        () => {
          renew();
          return write();
        },
        io,
      );
    },
    release() {
      clearInterval(heartbeat);
      try {
        io.fs.unlinkSync(marker);
      } catch (error) {
        if (errno(error) === "ENOENT") return;
        throw error;
      }
      removeEmpty(folder, io);
    },
  };
}
