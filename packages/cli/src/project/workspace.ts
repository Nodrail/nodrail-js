import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProjectSetup } from "@nodrail/policy-engine/yaml";

/** A file of the reviewed workspace, by project path, hashed as bytes. */
export type Hashed = { path: string; sha256: string };

/**
 * Whether the project declares a setup for a host: then the lock records the
 * whole workspace, not only the policy.
 */
export const declaresSetup = (setup: ProjectSetup) =>
  setup.runtimes.length > 0 ||
  setup.agents.length > 0 ||
  setup.connections.length > 0;

/**
 * The files a setup copies to hosts besides its policy: each agent's
 * instructions, every file of each skill folder and each plugin's folder,
 * links left out (setup refuses them). Sorted, so any machine lists them
 * alike.
 */
export function contentFiles(
  root: string,
  setup: ProjectSetup,
  hash: (bytes: Uint8Array) => string,
): Hashed[] {
  const found = new Map<string, string>();
  const add = (path: string) => {
    try {
      found.set(path, hash(readFileSync(join(root, path))));
    } catch {
      // A missing source is the resolver's problem to report, not the lock's.
    }
  };
  const walk = (folder: string) => {
    let entries: string[];
    try {
      entries = readdirSync(join(root, folder));
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = `${folder}/${entry}`;
      const stat = lstatSync(join(root, path));
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) add(path);
    }
  };
  for (const agent of setup.agents) {
    if (agent.instructions) add(agent.instructions);
    for (const folder of agent.skills) walk(folder);
  }
  // A plugin's code and skills, which the hosts load from its folder.
  for (const plugin of setup.plugins) walk(plugin.folder);
  return [...found].map(([path, sha256]) => ({ path, sha256 })).sort(byPath);
}

/** Paths in byte order of their UTF-8, the same on every machine. */
export const byPath = (a: Hashed, b: Hashed) =>
  Buffer.compare(Buffer.from(a.path), Buffer.from(b.path));

/**
 * One digest for the reviewed workspace: a line `<sha256>  <path>` for each
 * file, in path order, hashed. Catalog files are named `<id>@<version>/<path>`.
 */
export function workspaceDigest(
  files: Hashed[],
  hash: (text: string) => string,
) {
  const unique = new Map(files.map((file) => [file.path, file.sha256]));
  return hash(
    [...unique]
      .map(([path, sha256]) => ({ path, sha256 }))
      .sort(byPath)
      .map((file) => `${file.sha256}  ${file.path}\n`)
      .join(""),
  );
}

/** What changed between two lists of files, one line each. */
export function fileChanges(before: Hashed[], after: Hashed[]) {
  const old = new Map(before.map((file) => [file.path, file.sha256]));
  const now = new Map(after.map((file) => [file.path, file.sha256]));
  return [
    ...after.flatMap((file) =>
      !old.has(file.path)
        ? [`+ ${file.path}`]
        : old.get(file.path) !== file.sha256
          ? [`~ ${file.path}`]
          : [],
    ),
    ...before.flatMap((file) => (now.has(file.path) ? [] : [`- ${file.path}`])),
  ];
}
