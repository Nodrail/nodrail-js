// The local run ledger: one JSON Lines file per run, kept inside the
// repository's git directory, so it is never committed and every worktree of
// the repository shares it. Node only; the engine itself never reads files.
import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  truncateSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { runEvent, type RunEvent } from "./runs.ts";

export { ledgerDirectory, runKey, type Environment } from "./run-key.ts";

/** Past this, a run is too long to decide on; start another with NODRAIL_RUN. */
export const MAX_EVENTS = 20_000;

/** How long a hook waits for another to finish with a run, and when a lock is stale. */
const LOCK_WAIT_MS = 5000;
const LOCK_STALE_MS = 30_000;

/** A readable name that can't escape the folder, made unique by a hash. */
export function runFile(directory: string, run: string) {
  const readable = run
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[.-]+/, "")
    .slice(0, 60);
  const hash = createHash("sha256").update(run).digest("hex").slice(0, 12);
  return join(directory, `${readable || "run"}.${hash}.jsonl`);
}

function parseLine(text: string, where: string) {
  try {
    const raw = JSON.parse(text) as { run?: unknown; event?: unknown };
    if (typeof raw.run !== "string") throw new Error("no run");
    return { run: raw.run, event: runEvent.parse(raw.event) };
  } catch {
    throw new Error(`${where}: this line of the run ledger can't be read.`);
  }
}

/**
 * Every line of a ledger file. A last line with no newline is a write that was
 * cut off, and is left out when it can't be read; any other line that can't
 * be read throws: a history with a hole in it can't be trusted to hold a gate.
 */
function readFile(file: string) {
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  const torn = text.endsWith("\n") ? null : lines.pop();
  const items = lines.flatMap((line, index) =>
    line.trim() ? [parseLine(line, `${file}:${index + 1}`)] : [],
  );
  if (torn?.trim())
    try {
      items.push(parseLine(torn, file));
    } catch {
      // Cut off while it was written; it never counted.
    }
  return items;
}

/** Every event of a run, in the order recorded. */
export function readRun(directory: string, run: string): RunEvent[] {
  const file = runFile(directory, run);
  if (!existsSync(file)) return [];
  const events = readFile(file)
    .filter((item) => item.run === run)
    .map((item) => item.event);
  if (events.length >= MAX_EVENTS)
    throw new Error(
      `Run "${run}" has ${MAX_EVENTS} events. Start a new run with NODRAIL_RUN.`,
    );
  return events;
}

/**
 * Whether the file ends in the middle of a line, as a cut-off write leaves it.
 * Opened once and measured through the handle, so nothing can change the file
 * between looking and reading.
 */
function endsMidLine(file: string) {
  let handle: number;
  try {
    handle = openSync(file, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  try {
    const { size } = fstatSync(handle);
    if (!size) return false;
    const last = Buffer.alloc(1);
    readSync(handle, last, 0, 1, size - 1);
    return last[0] !== 0x0a;
  } finally {
    closeSync(handle);
  }
}

/**
 * A last line with no newline is finished when it reads as an event, and
 * otherwise cut away: it was a write that never completed, and left there it
 * would become a broken line once another followed it.
 */
function repairTail(file: string) {
  if (!endsMidLine(file)) return;
  const text = readFileSync(file, "utf8");
  const whole = text.slice(0, text.lastIndexOf("\n") + 1);
  try {
    parseLine(text.slice(whole.length), file);
    appendFileSync(file, "\n");
  } catch {
    truncateSync(file, Buffer.byteLength(whole));
  }
}

/** Adds one event as one whole line. Call it holding the run's lock. */
export function record(directory: string, run: string, event: RunEvent) {
  mkdirSync(directory, { recursive: true });
  const file = runFile(directory, run);
  const line = `${JSON.stringify({ run, event: runEvent.parse(event) })}\n`;
  repairTail(file);
  appendFileSync(file, line);
}

const pause = (ms: number) =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function takeLock(lock: string) {
  try {
    closeSync(openSync(lock, "wx"));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  try {
    // A hook that died holding the lock must not block the run for good.
    if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) unlinkSync(lock);
  } catch {
    // Released meanwhile.
  }
  return false;
}

/**
 * Runs `work` while no other hook works on this run, so reading the history,
 * deciding and recording are one step. Throws when the run stays busy.
 */
export function withRunLock<T>(directory: string, run: string, work: () => T) {
  mkdirSync(directory, { recursive: true });
  const lock = `${runFile(directory, run)}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (!takeLock(lock)) {
    if (Date.now() > deadline)
      throw new Error(`Run "${run}" is busy: another hook holds ${lock}.`);
    pause(10 + Math.floor(Math.random() * 20));
  }
  try {
    return work();
  } finally {
    try {
      unlinkSync(lock);
    } catch {
      // Already gone.
    }
  }
}

/** Every run in the folder, by its key, read once each for listing and reports. */
export function readRuns(directory: string) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith(".jsonl"))
    .sort()
    .flatMap((name) => {
      const items = readFile(join(directory, name));
      const run = items[0]?.run;
      if (run === undefined) return [];
      const events = items
        .filter((item) => item.run === run)
        .map((item) => item.event);
      return [{ run, events }];
    });
}
