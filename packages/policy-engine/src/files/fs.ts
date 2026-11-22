// The thin file-system side of a write check: reads the current files a
// request touches, refusing what could make the checked file differ from
// the written one. Every folder from the project root down and the file
// itself must be real (no symlink anywhere below the root), the file must be
// a regular file with one link, and it is opened without following links.
// What is refused is `unsafe`, and a check denies it. Reading still happens
// before the host writes: the result stays `preflight-only`.
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { join, sep } from "node:path";
import { checkWrite, type WriteCheck, type WriteCheckInput } from "./check.ts";
import { FILE_LIMITS } from "./limits.ts";
import type { CurrentFile } from "./plan.ts";

const unsafe = (reason: string): CurrentFile => ({ state: "unsafe", reason });

const missing = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === "ENOENT" ||
  (error as NodeJS.ErrnoException).code === "ENOTDIR";

/** The first problem on the way from the root to the file, or "absent"/"file". */
function walk(root: string, path: string): CurrentFile | "file" {
  const parts = path.split("/");
  let here = root;
  for (const [index, part] of parts.entries()) {
    here = join(here, part);
    let stat;
    try {
      stat = lstatSync(here);
    } catch (error) {
      if (missing(error)) return { state: "absent" };
      return unsafe("can't be inspected");
    }
    if (stat.isSymbolicLink()) return unsafe("is reached through a symlink");
    const last = index === parts.length - 1;
    if (!last && !stat.isDirectory()) return { state: "absent" };
    if (last && !stat.isFile()) return unsafe("isn't a regular file");
  }
  return "file";
}

function readOpen(descriptor: number): CurrentFile {
  const stat = fstatSync(descriptor);
  if (!stat.isFile()) return unsafe("isn't a regular file");
  if (stat.nlink > 1) return unsafe("has more than one hard link");
  if (stat.size > FILE_LIMITS.maxBytes)
    return unsafe(`is over ${FILE_LIMITS.maxBytes} bytes`);
  const content = Buffer.alloc(stat.size);
  let read = 0;
  while (read < stat.size) {
    const count = readSync(descriptor, content, read, stat.size - read, read);
    if (count === 0) break;
    read += count;
  }
  const bytes = new Uint8Array(content.subarray(0, read));
  const revision = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  return { state: "present", content: bytes, revision };
}

/**
 * The current state of a project-relative path under `projectRoot`. The
 * root itself is resolved once; nothing below it may be a link.
 */
export function readCurrentFile(
  projectRoot: string,
  path: string,
): CurrentFile {
  let root: string;
  try {
    root = realpathSync.native(projectRoot);
  } catch {
    return unsafe("has no readable project folder");
  }
  const found = walk(root, path);
  if (found !== "file") return found;
  const full = join(root, ...path.split("/"));
  if (!full.startsWith(root + sep)) return unsafe("is outside the project");
  let descriptor: number;
  try {
    descriptor = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return unsafe("can't be opened without following a link");
  }
  try {
    return readOpen(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/** The project folder as given and as resolved, so either spelling is inside. */
function spellings(projectRoot: string) {
  try {
    const real = realpathSync.native(projectRoot);
    return real === projectRoot ? [projectRoot] : [projectRoot, real];
  } catch {
    return [projectRoot];
  }
}

/**
 * checkWrite with the current files read from disk, each once. Still
 * `preflight-only`: the host writes after this returns.
 */
export function checkWriteOnDisk(
  input: Omit<WriteCheckInput, "current" | "mediated" | "projectRoot"> & {
    projectRoot: string;
  },
): WriteCheck {
  const read = new Map<string, CurrentFile>();
  const current = (path: string) => {
    if (!read.has(path))
      read.set(path, readCurrentFile(input.projectRoot, path));
    return read.get(path)!;
  };
  return checkWrite({
    ...input,
    projectRoot: spellings(input.projectRoot),
    current,
  });
}
