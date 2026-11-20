import {
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { CliError } from "../io.ts";
import { sha256 } from "./lockfile.ts";

/**
 * A setup write as a journal: every file's new bytes are staged with what was
 * on disk when the plan was made, then marked ready, then put in place one by
 * one. Replaying it is safe at any point: a file already in its new state is
 * skipped, one still in its old state is changed, and one that is neither was
 * changed by someone else meanwhile and is left alone.
 */
export type JournalEntry = {
  /** A `/`-separated path inside the project. */
  path: string;
  /** The hash on disk before, or null when there was no file. */
  before: string | null;
  /** The new bytes' hash, or null to remove the file. */
  after: string | null;
};

const JOURNAL = "setup.json";
const READY = "setup-ready";

const safePath = (path: string) =>
  !path.startsWith("/") &&
  !path.includes("\\") &&
  path.split("/").every((part) => part !== "" && part !== "." && part !== "..");

/** The hash of the file's bytes, or null when there is no file. */
export function onDisk(root: string, path: string) {
  try {
    return sha256(readFileSync(join(root, path)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Stages the journal and its files in `folder`, then marks it ready. */
export function stageJournal(
  folder: string,
  entries: JournalEntry[],
  contents: ReadonlyMap<string, Buffer>,
) {
  mkdirSync(join(folder, "setup"));
  entries.forEach((entry, index) => {
    if (!safePath(entry.path)) throw new Error(`Unsafe path ${entry.path}`);
    if (entry.after !== null)
      writeFileSync(
        join(folder, "setup", String(index)),
        contents.get(entry.path)!,
        {
          flush: true,
        },
      );
  });
  const journal = JSON.stringify(entries);
  writeFileSync(join(folder, JOURNAL), journal, { flush: true });
  writeFileSync(join(folder, READY), sha256(journal), { flush: true });
}

/** The ready journal in `folder`, or null when it never got that far. */
function readJournal(folder: string): JournalEntry[] | null {
  let journal: string;
  let ready: string;
  try {
    journal = readFileSync(join(folder, JOURNAL), "utf8");
    ready = readFileSync(join(folder, READY), "utf8");
  } catch {
    return null;
  }
  if (sha256(journal) !== ready) return null;
  const entries = JSON.parse(journal) as JournalEntry[];
  return entries.every((entry) => safePath(entry.path)) ? entries : null;
}

/** Whether `folder` holds a setup journal, ready or not. */
export const hasJournal = (folder: string) => {
  try {
    lstatSync(join(folder, "setup"));
    return true;
  } catch {
    return false;
  }
};

/**
 * Makes every folder on the way to `path`, refusing any that is a link: a
 * link could send the write outside the project.
 */
function folderFor(root: string, path: string) {
  const parts = path.split("/").slice(0, -1);
  let at = root;
  for (const part of parts) {
    at = join(at, part);
    try {
      if (lstatSync(at).isSymbolicLink())
        throw new Error(`${path} goes through a link; not written`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      mkdirSync(at);
    }
  }
}

function put(root: string, path: string, bytes: Buffer) {
  folderFor(root, path);
  const target = join(root, path);
  const temporary = `${target}.${process.pid}.nodrail-tmp`;
  rmSync(temporary, { force: true });
  writeFileSync(temporary, bytes, { flag: "wx", flush: true });
  renameSync(temporary, target);
}

function remove(root: string, path: string) {
  folderFor(root, path);
  rmSync(join(root, path), { force: true });
}

/**
 * Replays a ready journal onto the project. Returns the paths left alone
 * because someone changed them since the plan, or null when the journal
 * was never marked ready, so nothing of it was written.
 */
export function replayJournal(root: string, folder: string) {
  const entries = readJournal(folder);
  if (entries === null) return null;
  const left: string[] = [];
  entries.forEach((entry, index) => {
    const now = onDisk(root, entry.path);
    if (now === entry.after) return;
    if (now !== entry.before) {
      left.push(entry.path);
      return;
    }
    if (entry.after === null) remove(root, entry.path);
    else {
      const bytes = readFileSync(join(folder, "setup", String(index)));
      if (sha256(bytes) !== entry.after) {
        left.push(entry.path);
        return;
      }
      put(root, entry.path, bytes);
    }
  });
  return left;
}

/**
 * A journal being written: each change records what the file holds now and
 * the digest it will hold after, and keeps the bytes to write.
 */
export function journalWriter(root: string) {
  const contents = new Map<string, Buffer>();
  const entries: JournalEntry[] = [];
  const change = (path: string, bytes: Buffer | null) => {
    if (bytes) contents.set(path, bytes);
    entries.push({
      path,
      before: onDisk(root, path),
      after: bytes ? sha256(bytes) : null,
    });
  };
  return { entries, contents, change };
}

/**
 * Inside the project's hold: plans again, refuses when that differs from
 * what the person reviewed, then writes the journal and replays it.
 * Answers what replaying left undone.
 */
export function replayReviewed<Plan>(
  folder: string,
  root: string,
  plans: {
    reviewed: Plan;
    now: Plan;
    same: (a: Plan, b: Plan) => boolean;
    again: string;
  },
  journal: (plan: Plan) => {
    entries: JournalEntry[];
    contents: Map<string, Buffer>;
  },
) {
  if (!plans.same(plans.now, plans.reviewed))
    throw new CliError(
      `The project changed after the plan was shown. Nothing was changed; run ${plans.again} again to see the new plan.`,
    );
  const { entries, contents } = journal(plans.now);
  if (entries.length === 0) return [];
  stageJournal(folder, entries, contents);
  return replayJournal(root, folder) ?? [];
}
