import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { CliError } from "../io.ts";
import { hasJournal, replayJournal } from "./journal.ts";
import {
  acquireLocalLock,
  LocalLockBusy,
  processAlive,
} from "@nodrail/policy-engine/command-line";
import { LOCK_FILE, MANIFEST_FILE, sha256 } from "./lockfile.ts";

/** The only files a project write ever replaces. */
const WRITABLE = new Set([MANIFEST_FILE, LOCK_FILE]);

/** A project, and the person's home where its writes are staged. */
export type Place = { root: string; home: string };

/**
 * Where writes to this project are staged: in the person's own home, named
 * after the project's real path, so nothing inside the repository (an agent's
 * file, a commit) can stand in for a write nodrail started. It holds the
 * writer's process id, the new files and, once all are complete, `ready`
 * with each file's hash. Its existence is the writers' lock.
 */
export function stagingFolder({ root, home }: Place) {
  const project = createHash("sha256")
    .update(realpathSync(root))
    .digest("hex")
    .slice(0, 32);
  return join(home, ".nodrail", "writes", project);
}

function readOr(path: string) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/**
 * Replaces one project file: written in full beside it, then renamed over
 * it. The temporary file is created new, so a link planted at its name can't
 * send the text anywhere else.
 */
function replace(root: string, name: string, text: string) {
  const destination = join(root, name);
  const mode =
    statSync(destination, { throwIfNoEntry: false })?.mode ??
    0o666 & ~process.umask();
  const temporary = join(root, `.${name}.${process.pid}.tmp`);
  rmSync(temporary, { force: true });
  try {
    writeFileSync(temporary, text, { flag: "wx", flush: true, mode: 0o600 });
    chmodSync(temporary, mode & 0o7777);
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** The staged files, if every one is complete and is what was staged. */
function staged(folder: string): Record<string, string> | null {
  let hashes: Record<string, string>;
  try {
    hashes = JSON.parse(readOr(join(folder, "ready"))) as Record<
      string,
      string
    >;
  } catch {
    return null;
  }
  const files: Record<string, string> = {};
  for (const [name, hash] of Object.entries(hashes)) {
    const text = readOr(join(folder, "next", name));
    if (!WRITABLE.has(name) || sha256(text) !== hash) return null;
    files[name] = text;
  }
  return files;
}

/**
 * Finishes or undoes a write that stopped: when every new file was staged
 * and still matches its hash, they are put in place; otherwise none are, and
 * the project keeps its previous files. Either way it is whole again.
 */
function recover(place: Place, folder: string) {
  if (hasJournal(folder)) {
    // An apply's journal: finish it if it was marked ready, else drop it.
    // Its last entry is the setup state, so a stop partway leaves files the
    // next plan sees as already right or as not nodrail's, never as owned.
    // The folder goes even if finishing fails, so the project isn't held.
    try {
      replayJournal(place.root, folder);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
    return;
  }
  const files = staged(folder);
  if (files)
    for (const [name, text] of Object.entries(files))
      replace(place.root, name, text);
  rmSync(folder, { recursive: true, force: true });
}

/** Whether a write to this project is under way or was interrupted. */
export const writeInProgress = (place: Place) =>
  existsSync(stagingFolder(place));

/**
 * Runs `change` as the project's only writer and replaces the files it
 * returns all together: each is staged in full first, then all are put in
 * place. An interrupted run leaves either every old file or, on the next
 * command, every new one; never a mix that a frozen export would accept.
 */
export function writeProject(
  place: Place,
  change: () => Record<string, string> | null,
) {
  holdProject(place, (folder) => {
    const files = change() ?? {};
    const names = Object.keys(files);
    if (names.some((name) => !WRITABLE.has(name)))
      throw new Error(
        `A project write may only replace ${[...WRITABLE].join(" and ")}`,
      );
    if (names.length > 0) {
      mkdirSync(join(folder, "next"), { mode: 0o700 });
      for (const name of names)
        writeFileSync(join(folder, "next", name), files[name]!, {
          flush: true,
          mode: 0o600,
        });
      const hashes = Object.fromEntries(
        names.map((name) => [name, sha256(files[name]!)]),
      );
      writeFileSync(join(folder, "ready"), JSON.stringify(hashes), {
        flush: true,
        mode: 0o600,
      });
      for (const name of names) replace(place.root, name, files[name]!);
    }
  });
}

/**
 * Runs `work` as the project's only writer, with the staging folder for its
 * writes. Whatever it staged and marked ready is the project afterwards, even
 * if it stopped partway: the finish below, or the next writer, completes it.
 */
export function holdProject<T>(place: Place, work: (folder: string) => T): T {
  const folder = stagingFolder(place);
  const lock = projectLock(folder, false);
  try {
    if (existsSync(folder)) {
      // Older CLI versions put their process ID inside the journal itself.
      const owner = Number(readOr(join(folder, "owner")));
      if (owner && processAlive(owner))
        throw new CliError(
          `Another nodrail (process ${owner}) is changing this project. Try again when it has finished.`,
        );
      recover(place, folder);
    }
    mkdirSync(folder, { mode: 0o700 });
    try {
      return work(folder);
    } finally {
      recover(place, folder);
    }
  } finally {
    lock.release();
  }
}

function projectLock(folder: string, leased: boolean) {
  try {
    return acquireLocalLock(`${folder}.lock`, { leased });
  } catch (error) {
    if (error instanceof LocalLockBusy) throw new CliError(error.message);
    throw error;
  }
}

export type WriterLock = Pick<
  ReturnType<typeof acquireLocalLock>,
  "renew" | "commit"
>;

/** Holds a named local writer lock while an asynchronous operation settles. */
export async function holdProjectAsync<T>(
  folder: string,
  work: (lock: WriterLock) => Promise<T>,
) {
  const lock = projectLock(folder, true);
  try {
    return await work(lock);
  } catch (error) {
    if (error instanceof LocalLockBusy) throw new CliError(error.message);
    throw error;
  } finally {
    lock.release();
  }
}
