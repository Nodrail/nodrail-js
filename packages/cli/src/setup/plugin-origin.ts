import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  type Dirent,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import type { PluginSpec } from "@nodrail/policy-engine/yaml";
import type { Env } from "../config.ts";
import { CliError } from "../io.ts";

/**
 * A plugin someone else publishes, copied into the project at one commit.
 * The files are read from git's objects at that commit, never checked out,
 * so nothing in the repository runs: no hook, no filter, no submodule. A
 * link or a submodule in the plugin's folder is refused. Once copied, the
 * folder is the project's: the lock covers it, and a new commit is a change
 * `nodrail policy lock` shows.
 */

export type PluginFile = { bytes: Buffer; executable: boolean };

const MAX_FILES = 2000;
const MAX_BYTES = 50 * 1024 * 1024;

/** git, never asking for a password, with the repository's hooks off. */
function git(args: string[], env: Env, cwd?: string) {
  const run = spawnSync(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "protocol.ext.allow=never",
      ...args,
    ],
    {
      cwd,
      env: {
        ...(env as NodeJS.ProcessEnv),
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "echo",
      },
      maxBuffer: MAX_BYTES * 2,
    },
  );
  if (run.error)
    throw new CliError(
      `git didn't run: ${run.error.message}. Install git to fetch plugins.`,
    );
  return run;
}

const text = (buffer: Buffer | null) =>
  (buffer ?? Buffer.alloc(0)).toString("utf8").trim();

/** The plugin's files at its commit, by path in its folder. */
export function fetchPlugin(
  name: string,
  origin: NonNullable<PluginSpec["from"]>,
  env: Env,
) {
  const repo = mkdtempSync(join(tmpdir(), "nodrail-plugin-"));
  try {
    const clone = git(
      [
        "clone",
        "--bare",
        "--quiet",
        "--no-tags",
        "--filter=blob:none",
        origin.git,
        repo,
      ],
      env,
    );
    if (clone.status !== 0)
      throw new CliError(
        `Plugin ${name}: can't clone ${origin.git}: ${text(clone.stderr)}`,
      );
    const has = () =>
      git(["cat-file", "-e", `${origin.commit}^{commit}`], env, repo).status ===
      0;
    // A commit no branch reaches yet: hosts like GitHub serve it by its id.
    if (!has()) git(["fetch", "--quiet", "origin", origin.commit], env, repo);
    if (!has())
      throw new CliError(
        `Plugin ${name}: ${origin.git} has no commit ${origin.commit}.`,
      );
    return filesAt(name, origin, env, repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

function filesAt(
  name: string,
  origin: NonNullable<PluginSpec["from"]>,
  env: Env,
  repo: string,
) {
  const folder = origin.path?.replace(/\/+$/, "") ?? "";
  const listed = git(
    [
      "ls-tree",
      "-r",
      "-z",
      "--full-tree",
      origin.commit,
      ...(folder ? ["--", `${folder}/`] : []),
    ],
    env,
    repo,
  );
  if (listed.status !== 0)
    throw new CliError(
      `Plugin ${name}: can't list ${origin.commit}: ${text(listed.stderr)}`,
    );
  const entries = text(listed.stdout).split("\0").filter(Boolean);
  if (entries.length === 0)
    throw new CliError(
      `Plugin ${name}: ${folder || "the repository"} is empty at ${origin.commit.slice(0, 12)}.`,
    );
  if (entries.length > MAX_FILES)
    throw new CliError(`Plugin ${name}: more than ${MAX_FILES} files.`);
  const files = new Map<string, PluginFile>();
  let total = 0;
  for (const entry of entries) {
    const [meta, path] = entry.split("\t") as [string, string];
    const [mode, type, oid] = meta.split(" ") as [string, string, string];
    const inside = folder ? path.slice(folder.length + 1) : path;
    refuseEntry(name, path, inside, { mode, type });
    const blob = git(["cat-file", "blob", oid], env, repo);
    if (blob.status !== 0)
      throw new CliError(`Plugin ${name}: can't read ${path}.`);
    total += blob.stdout.length;
    if (total > MAX_BYTES)
      throw new CliError(
        `Plugin ${name}: more than ${MAX_BYTES / 1024 / 1024} MB.`,
      );
    files.set(inside, { bytes: blob.stdout, executable: mode === "100755" });
  }
  return files;
}

/** A path nodrail won't write, a link or a submodule: refused, with why. */
function refuseEntry(
  name: string,
  path: string,
  inside: string,
  { mode, type }: { mode: string; type: string },
) {
  if (inside.split("/").some((part) => ["", ".", "..", ".git"].includes(part)))
    throw new CliError(
      `Plugin ${name}: ${path} isn't a path nodrail will write.`,
    );
  if (type !== "blob" || mode === "120000")
    throw new CliError(
      `Plugin ${name}: ${path} is a ${type === "commit" ? "submodule" : "link"}; only plain files are copied.`,
    );
}

/** The files a folder holds now, by path in it; a link is refused. */
export function filesIn(folder: string): Map<string, PluginFile> {
  const files = new Map<string, PluginFile>();
  const walk = (at: string) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(at, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(at, entry.name);
      const inside = relative(folder, path).split(sep).join("/");
      if (entry.isSymbolicLink()) throw linkRefused(inside);
      if (entry.isDirectory()) walk(path);
      else files.set(inside, plainFile(path, inside));
    }
  };
  walk(folder);
  return files;
}

const linkRefused = (inside: string) =>
  new CliError(
    `${inside} in the plugin folder is a link; nodrail won't replace it.`,
  );

/**
 * One plain file, read through a single handle: opened without following a
 * link and measured on that handle, so a file swapped for a link after the
 * folder was listed is refused, never read through.
 */
function plainFile(path: string, inside: string): PluginFile {
  let handle: number;
  try {
    handle = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP")
      throw linkRefused(inside);
    throw error;
  }
  try {
    const stat = fstatSync(handle);
    if (!stat.isFile())
      throw new CliError(
        `${inside} in the plugin folder isn't a plain file; nodrail won't copy it.`,
      );
    return {
      bytes: readFileSync(handle),
      executable: (stat.mode & 0o100) !== 0,
    };
  } finally {
    closeSync(handle);
  }
}

export type FolderChanges = {
  added: string[];
  changed: string[];
  removed: string[];
};

/** What copying `want` over `have` changes. */
export function changesBetween(
  have: Map<string, PluginFile>,
  want: Map<string, PluginFile>,
): FolderChanges {
  const same = (a: PluginFile, b: PluginFile) =>
    a.executable === b.executable && a.bytes.equals(b.bytes);
  return {
    added: [...want.keys()].filter((path) => !have.has(path)).sort(),
    changed: [...want.keys()]
      .filter(
        (path) => have.has(path) && !same(have.get(path)!, want.get(path)!),
      )
      .sort(),
    removed: [...have.keys()].filter((path) => !want.has(path)).sort(),
  };
}

/** The folder made to hold exactly `want`: other files out, empty folders too. */
export function writeFolder(
  folder: string,
  want: Map<string, PluginFile>,
  changes: FolderChanges,
) {
  for (const path of changes.removed) {
    rmSync(join(folder, path), { force: true });
    for (
      let at = dirname(join(folder, path));
      at.startsWith(folder) && at !== folder;
      at = dirname(at)
    ) {
      if (readdirSync(at).length > 0) break;
      rmdirSync(at);
    }
  }
  for (const path of [...changes.added, ...changes.changed]) {
    const file = want.get(path)!;
    const target = join(folder, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.bytes);
    chmodSync(target, file.executable ? 0o755 : 0o644);
  }
}
