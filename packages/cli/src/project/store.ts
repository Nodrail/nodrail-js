import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { CliError } from "../io.ts";
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

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

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
  const temporary = join(root, `.${name}.${process.pid}.tmp`);
  rmSync(temporary, { force: true });
  writeFileSync(temporary, text, { flag: "wx", flush: true });
  renameSync(temporary, join(root, name));
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
  const files = staged(folder);
  if (files)
    for (const [name, text] of Object.entries(files))
      replace(place.root, name, text);
  rmSync(folder, { recursive: true, force: true });
}

/** Whether a write to this project is under way or was interrupted. */
export const writeInProgress = (place: Place) =>
  existsSync(stagingFolder(place));

function takeLock(place: Place, folder: string) {
  mkdirSync(join(folder, ".."), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(folder);
      writeFileSync(join(folder, "owner"), String(process.pid));
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const owner = Number(readOr(join(folder, "owner")));
    if (owner && owner !== process.pid && alive(owner))
      throw new CliError(
        `Another nodrail (process ${owner}) is changing this project. Try again when it has finished.`,
      );
    recover(place, folder);
  }
  throw new CliError(
    `Couldn't start a write to this project; if no nodrail is running, remove ${folder}.`,
  );
}

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
  const folder = stagingFolder(place);
  takeLock(place, folder);
  try {
    const files = change() ?? {};
    const names = Object.keys(files);
    if (names.some((name) => !WRITABLE.has(name)))
      throw new Error(
        `A project write may only replace ${[...WRITABLE].join(" and ")}`,
      );
    if (names.length > 0) {
      mkdirSync(join(folder, "next"));
      for (const name of names)
        writeFileSync(join(folder, "next", name), files[name]!, {
          flush: true,
        });
      const hashes = Object.fromEntries(
        names.map((name) => [name, sha256(files[name]!)]),
      );
      writeFileSync(join(folder, "ready"), JSON.stringify(hashes), {
        flush: true,
      });
      for (const name of names) replace(place.root, name, files[name]!);
    }
  } finally {
    // Past `ready`, the new files are the project: finish putting them in place.
    recover(place, folder);
  }
}
