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
import native, { join, win32 } from "node:path";
import { canonicalPath, withoutNamespace } from "../paths.ts";
import { checkWrite, type WriteCheck, type WriteCheckInput } from "./check.ts";
import {
  absoluteProjectPath,
  projectPath,
  type PathResult,
} from "./contracts.ts";
import { FILE_LIMITS } from "./limits.ts";
import type { CurrentFile } from "./plan.ts";

const unsafe = (reason: string): CurrentFile => ({ state: "unsafe", reason });

const missing = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === "ENOENT" ||
  (error as NodeJS.ErrnoException).code === "ENOTDIR";

/** The first problem on the way from the root to the file, or "absent"/"file". */
function walk(root: string, path: string): CurrentFile | string {
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
  return here;
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
  return readFromRoot(realRoot(projectRoot), path);
}

function realRoot(projectRoot: string) {
  try {
    return realpathSync.native(projectRoot);
  } catch {
    return null;
  }
}

function readFromRoot(root: string | null, path: string): CurrentFile {
  if (!root) return unsafe("has no readable project folder");
  // This API takes a project-relative contract path, even on Windows.
  const normalized = projectPath(root, root, path, native);
  if (!normalized.ok || normalized.path !== path)
    return unsafe("isn't a normalized project-relative path");
  const found = walk(root, path);
  return typeof found === "string" ? readFile(found) : found;
}

function readFile(full: string): CurrentFile {
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

function windowsParts(path: string) {
  const absolute = win32.normalize(withoutNamespace(path));
  const { root } = win32.parse(absolute);
  return {
    root,
    parts: absolute.slice(root.length).split("\\").filter(Boolean),
  };
}

/** Locate the on-disk root even when the tool uses another 8.3 spelling. */
function windowsRelative(absolute: string, roots: string[], real: string) {
  const { root, parts } = windowsParts(absolute);
  for (const spelling of roots) {
    const depth = windowsParts(spelling).parts.length;
    if (depth >= parts.length) continue;
    const ancestor = win32.join(root, ...parts.slice(0, depth));
    if (realRoot(ancestor) === real) return parts.slice(depth).join("/");
  }
  return null;
}

function windowsLocator(roots: string[], cwd: string, real: string) {
  return (name: string): PathResult => {
    const absolute = absoluteProjectPath(cwd, name, win32);
    if (!absolute.ok) return absolute;
    const path = windowsRelative(absolute.path, roots, real);
    if (path === null) {
      const written = projectPath(roots, cwd, name, win32);
      return written.ok
        ? {
            ok: false,
            code: "unsafe-path",
            message: "has no matching project folder on disk",
          }
        : written;
    }
    // Validate the relative name before disk access. Keep links visible to the
    // reader, but use the disk's long names for regular or not-yet-created files.
    const written = projectPath(real, real, path, win32);
    if (!written.ok) return written;
    const found = walk(real, path);
    if (typeof found !== "string" && found.state === "unsafe") return written;
    return projectPath(
      real,
      real,
      canonicalPath(join(real, ...path.split("/"))),
      win32,
    );
  };
}

/**
 * checkWrite with the current files read from disk, each once. Still
 * `preflight-only`: the host writes after this returns.
 */
export function checkWriteOnDisk(
  input: Omit<
    WriteCheckInput,
    "current" | "locate" | "mediated" | "pathFlavor" | "projectRoot"
  > & {
    projectRoot: string;
  },
): WriteCheck {
  const read = new Map<string, CurrentFile>();
  const real = realRoot(input.projectRoot);
  const roots =
    real && real !== input.projectRoot
      ? [input.projectRoot, real]
      : [input.projectRoot];
  const current = (path: string) => {
    if (!read.has(path)) read.set(path, readFromRoot(real, path));
    return read.get(path)!;
  };
  return checkWrite({
    ...input,
    projectRoot: roots,
    pathFlavor: native,
    ...(real && process.platform === "win32"
      ? { locate: windowsLocator(roots, input.cwd, real) }
      : {}),
    current,
  });
}
