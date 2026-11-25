import { createHash, randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative } from "node:path";

const settingsFile = ".claude/settings.json";
const inputs = [
  "nodrail.yaml",
  "nodrail.lock.yaml",
  ".nodrail/connect.json",
  ".nodrail/effective.yaml",
  ".nodrail/protected.txt",
  ".nodrail/connections.json",
  ".nodrail/telemetry.json",
  ".nodrail/evidence.json",
];
const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");

function snapshot(root: string) {
  return inputs.map((file) => {
    try {
      return hash(readFileSync(join(root, file)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return null;
    }
  });
}

const folderOf = (home: string) => join(home, ".nodrail", "applied-hooks");
const recordOf = (home: string, root: string) =>
  join(folderOf(home), `${hash(realpathSync(root))}.json`);

type Settings = {
  disableAllHooks?: boolean;
  allowManagedHooksOnly?: boolean;
  hooks?: Record<string, unknown[]>;
};

const nativeOwner = { getuid: process.getuid };

function privatePath(
  path: string,
  directory: boolean,
  owner: typeof nativeOwner,
  writable = 0o077,
) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return false;
  return (
    (directory ? stat.isDirectory() : stat.isFile()) &&
    (owner.getuid === undefined ||
      (stat.uid === owner.getuid() && (stat.mode & writable) === 0))
  );
}

/** Called by apply after installing the reviewed files and settings. */
export function recordAppliedHook(
  home: string,
  root: string,
  expected: Record<string, unknown>,
  owner = nativeOwner,
) {
  const folder = folderOf(home);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  if (
    !privatePath(join(home, ".nodrail"), true, owner, 0o022) ||
    !privatePath(folder, true, owner)
  )
    throw new Error(
      "The applied hook record directory must be private and user-owned.",
    );
  const file = recordOf(home, root);
  const before = (expected as Settings).hooks;
  const requiredHooks = Object.fromEntries(
    Object.entries(before ?? {}).flatMap(([event, groups]) => {
      if (!Array.isArray(groups)) return [];
      const group = groups.at(-1) as
        { hooks?: { command?: string }[] } | undefined;
      const command = group?.hooks?.[0]?.command;
      return command?.startsWith(
        'nodrail policy hook "$CLAUDE_PROJECT_DIR/.nodrail/',
      ) || command?.startsWith('nodrail observe "$CLAUDE_PROJECT_DIR"')
        ? [[event, group]]
        : [];
    }),
  );
  const previous = privatePath(file, false, owner)
    ? readFileSync(file, "utf8")
    : null;
  const settings = JSON.stringify(requiredHooks);
  const existing = priorRecord(previous);
  const generation =
    existing?.generation && JSON.stringify(existing.requiredHooks) === settings
      ? existing.generation
      : randomUUID();
  writePrivateRecord(
    file,
    JSON.stringify({ files: snapshot(root), requiredHooks, generation }),
  );
}

function priorRecord(value: string | null) {
  try {
    return value
      ? (JSON.parse(value) as { generation?: string; requiredHooks?: unknown })
      : null;
  } catch {
    return null;
  }
}

function writePrivateRecord(file: string, value: string) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, value, { mode: 0o600, flag: "wx" });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function readSettings(root: string, file: string): Settings {
  return JSON.parse(readFileSync(join(root, file), "utf8")) as Settings;
}

function localHooksAllowed(root: string) {
  try {
    const local = readSettings(root, ".claude/settings.local.json");
    return !local.disableAllHooks && !local.allowManagedHooksOnly;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

/** Remove delegation when destroy removes the project hook. */
export function removeAppliedHook(
  home: string,
  root: string,
  owner = nativeOwner,
) {
  const folder = folderOf(home);
  if (!privatePath(join(home, ".nodrail"), true, owner, 0o022)) return;
  if (!privatePath(folder, true, owner)) return;
  rmSync(recordOf(home, root), { force: true });
}

/** A checkout's own generated files are insufficient to establish trust. */
function appliedHook(
  home: string,
  root: string,
  cwd: string,
  owner: typeof nativeOwner,
) {
  try {
    const location = relative(realpathSync(root), realpathSync(cwd));
    if (isAbsolute(location) || location.split(/[\\/]/)[0] === "..")
      return null;
    const file = recordOf(home, root);
    if (
      !privatePath(join(home, ".nodrail"), true, owner, 0o022) ||
      !privatePath(folderOf(home), true, owner) ||
      !privatePath(file, false, owner)
    )
      return null;
    const record = JSON.parse(readFileSync(file, "utf8")) as {
      files: unknown;
      generation: string;
      requiredHooks: Record<string, unknown>;
    };
    const settings = readSettings(root, settingsFile);
    const verified =
      !!record.requiredHooks.PreToolUse &&
      !settings.disableAllHooks &&
      !settings.allowManagedHooksOnly &&
      localHooksAllowed(root) &&
      Object.entries(record.requiredHooks).every(([event, group]) =>
        settings.hooks?.[event]?.some(
          (actual) => JSON.stringify(actual) === JSON.stringify(group),
        ),
      ) &&
      JSON.stringify(record.files) === JSON.stringify(snapshot(root));
    return verified && typeof record.generation === "string"
      ? record.generation
      : null;
  } catch {
    return null;
  }
}

/** Only sessions started with the reviewed hook can use project enforcement. */
export function deferToAppliedHook(
  home: string,
  root: string,
  cwd: string,
  session: { id: string; starting: boolean; owner?: typeof nativeOwner },
) {
  const owner = session.owner ?? nativeOwner;
  const installed = appliedHook(home, root, cwd, owner);
  if (!installed) return false;
  const sessionFile = join(
    folderOf(home),
    `session-${hash(JSON.stringify([realpathSync(root), session.id]))}.json`,
  );
  try {
    if (session.starting) {
      writePrivateRecord(sessionFile, installed);
      return true;
    }
    return (
      privatePath(sessionFile, false, owner) &&
      readFileSync(sessionFile, "utf8") === installed
    );
  } catch {
    return false;
  }
}
