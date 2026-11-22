import { readFileSync } from "node:fs";
import { join } from "node:path";
import { folderHost } from "../project/host.ts";
import { sha256 } from "../project/lockfile.ts";
import type { DesiredFile } from "./claude-code.ts";
import type { Step } from "./plan.ts";
import {
  HOST_NAMES,
  hostState,
  otherOwners,
  type Runtime,
  type SetupState,
} from "./state.ts";

/**
 * Each file a plan would write or take out, against what is on disk: what
 * apply does to it, or why it is left alone as a conflict.
 */

/** The file's bytes, null when there is none, "folder" when a folder is. */
export function readBytes(
  root: string,
  path: string,
): Buffer | null | "folder" {
  try {
    return readFileSync(join(root, path));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    if (code === "EISDIR") return "folder";
    throw error;
  }
}

/** The state, and the host whose files a step is about. */
export type Owner = { state: SetupState | null; runtime: Runtime };

export function fileStep(root: string, owner: Owner, file: DesiredFile): Step {
  const { path, why } = file;
  // Never through a link: it could lead to a file outside the project.
  if (folderHost(root).real(path) !== path)
    return {
      path,
      action: "conflict",
      why: `${why}; the path goes through a link`,
    };
  const disk = readBytes(root, path);
  if (disk === null) return { path, action: "create", why };
  if (disk === "folder")
    return { path, action: "conflict", why: `${why}; a folder is there` };
  const now = sha256(disk);
  if (now === sha256(file.content)) return { path, action: "keep", why };
  // A file both hosts need, last written for the other one, is nodrail's
  // too while it holds what was written.
  const written =
    hostState(owner.state, owner.runtime)?.files[path] ??
    otherOwners(owner.state, owner.runtime, path).find(
      (other) => other.hash === now,
    )?.hash;
  if (written === undefined)
    return {
      path,
      action: "conflict",
      why: `${why}; already there, not written by nodrail`,
    };
  if (written !== now)
    return {
      path,
      action: "conflict",
      why: `${why}; edited since nodrail wrote it`,
    };
  return { path, action: "update", why };
}

export function goneStep(
  root: string,
  owner: Owner,
  path: string,
  hash: string,
): Step {
  const others = otherOwners(owner.state, owner.runtime, path);
  if (others.length > 0)
    return {
      path,
      action: "keep",
      why: `no longer needed here; kept for ${others.map((other) => HOST_NAMES[other.host]).join(" and ")}`,
    };
  return removalStep(root, path, hash, {
    edited: "no longer needed, but edited since nodrail wrote it",
    removed: "no longer needed",
  });
}

/**
 * Taking out a file nodrail wrote: nothing to do when it's gone, and kept,
 * as a conflict, when it was edited since.
 */
export function removalStep(
  root: string,
  path: string,
  hash: string,
  why: { edited: string; removed: string },
): Step {
  const disk = readBytes(root, path);
  if (disk === null) return { path, action: "keep", why: "already removed" };
  if (disk === "folder" || sha256(disk) !== hash)
    return { path, action: "conflict", why: why.edited };
  return { path, action: "remove", why: why.removed };
}
