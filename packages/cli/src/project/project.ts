import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  resolveProject,
  type Catalog,
  type ProjectHost,
  type ProjectResolution,
} from "@nodrail/policy-engine/yaml";
import { CliError } from "../io.ts";
import { bundledCatalog } from "./catalog.ts";
import { effectivePolicy } from "./effective.ts";
import { folderHost } from "./host.ts";
import { contentFiles, declaresSetup } from "./workspace.ts";
import {
  LOCK_FILE,
  lockFor,
  MANIFEST_FILE,
  pinsOf,
  readLock,
  sha256,
  type Lock,
} from "./lockfile.ts";

function readOptional(path: string) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** The project's manifest and lock as they are on disk. */
export function readProject(root: string) {
  const manifest = readOptional(join(root, MANIFEST_FILE));
  const lockText = readOptional(join(root, LOCK_FILE));
  const lock = lockText === null ? null : readLock(lockText);
  if (typeof lock === "string") throw new CliError(lock);
  return { manifest, lock, lockText };
}

/** Problems found while resolving, as one error naming each reference. */
function failOn(resolution: ProjectResolution) {
  if (resolution.problems.length === 0) return;
  throw new CliError(
    resolution.problems
      .map(
        ({ ref, from, message }) =>
          `${ref}${from ? ` (in ${from})` : ""}: ${message}`,
      )
      .join("\n"),
  );
}

/** What the project would be with this manifest: resolved, compiled, locked. */
export function planProject(input: {
  root: string;
  manifest: string;
  previous: Lock | null;
  pins?: Record<string, string>;
  catalog?: Catalog;
}) {
  const catalog = input.catalog ?? bundledCatalog();
  const files = folderHost(input.root);
  // The manifest under review may not be written yet: read it from here.
  const host: ProjectHost = {
    read: (path) =>
      path === MANIFEST_FILE ? input.manifest : files.read(path),
    real: (path) => (path === MANIFEST_FILE ? path : files.real(path)),
    list: (path) => files.list?.(path),
  };
  const resolution = resolveProject({
    host,
    catalog,
    manifest: MANIFEST_FILE,
    pins: { ...pinsOf(input.previous), ...input.pins },
  });
  failOn(resolution);
  const pending = resolution.modules.filter((use) => use.missing.length > 0);
  // What is in effect must compile. While a module waits for values, the
  // whole project is checked with stand-ins, so a file that layers over the
  // module is checked against it already.
  if (pending.length > 0) effectivePolicy(resolution.checking);
  const compiled =
    pending.length === 0 && resolution.sources.length > 0
      ? effectivePolicy(resolution.sources)
      : null;
  if (pending.length === 0 && compiled === null)
    throw new CliError(
      "The project has no rules yet. Add a module or a rules file.",
    );
  const effective = pending.length === 0 ? compiled : null;
  const lock = lockFor({
    resolution,
    manifest: { path: MANIFEST_FILE, text: input.manifest },
    catalog,
    effective: effective?.text ?? null,
    previous: input.previous,
    content: declaresSetup(resolution.setup)
      ? contentFiles(input.root, resolution.setup, sha256)
      : null,
  });
  return { resolution, catalog, effective, pending, lock };
}

export type ProjectPlan = ReturnType<typeof planProject>;

/**
 * Refuses a catalog module whose files differ from what the lock recorded
 * at the same version: a changed package is an error, never an update.
 */
export function checkIntegrity(previous: Lock | null, next: Lock) {
  for (const module of next.modules) {
    const locked = previous?.modules.find(
      (entry) => entry.id === module.id && entry.version === module.version,
    );
    if (!locked) continue;
    const same = JSON.stringify(locked.files) === JSON.stringify(module.files);
    if (same) continue;
    const changed = module.files
      .filter(
        (file) =>
          !locked.files.some(
            (entry) => entry.path === file.path && entry.sha256 === file.sha256,
          ),
      )
      .map((file) => file.path);
    throw new CliError(
      `${module.id}@${module.version} doesn't match nodrail.lock.yaml${changed.length ? ` (${changed.join(", ")})` : ""}. The installed package was changed; reinstall nodrail, or ask for another version with \`nodrail add ${module.id}@<version>\`.`,
    );
  }
}
