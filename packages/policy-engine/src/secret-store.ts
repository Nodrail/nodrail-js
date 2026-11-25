import {
  execFileSync,
  type ExecFileSyncOptionsWithStringEncoding,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  chmodSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, win32 } from "node:path";
import { withProcessLock } from "./local-lock.ts";

type SecretStoreIO = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  execute?: (
    file: string,
    args: string[],
    options: ExecFileSyncOptionsWithStringEncoding & { input: string },
  ) => string;
  chmod?: typeof chmodSync;
  fchmod?: typeof fchmodSync;
  open?: typeof openSync;
  lock?: typeof withProcessLock;
};

type Commit = (replace: () => void) => void;

type StoreIO = Omit<Required<SecretStoreIO>, "platform"> & { windows: boolean };

function privateDirectory(io: StoreIO, directory: string) {
  mkdirSync(directory, { mode: 0o700, recursive: true });
  if (!lstatSync(directory).isDirectory())
    throw new Error("Local secret directory must be a real directory.");
  if (!io.windows) io.chmod(directory, 0o700);
}

/** Records live directly in .nodrail or one private subdirectory. */
function prepareDirectory(io: StoreIO, file: string) {
  const directory = dirname(file);
  const parent = dirname(directory);
  if (basename(parent) === ".nodrail") privateDirectory(io, parent);
  privateDirectory(io, directory);
}

function dpapi(io: StoreIO, operation: "Protect" | "Unprotect", input: string) {
  const system = win32.join(io.env.SystemRoot ?? "C:\\Windows", "System32");
  try {
    const output = io.execute(
      win32.join(system, "WindowsPowerShell", "v1.0", "powershell.exe"),
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$ErrorActionPreference = 'Stop'
       Add-Type -AssemblyName System.Security
       $bytes = [Convert]::FromBase64String([Console]::In.ReadToEnd())
       $result = [Security.Cryptography.ProtectedData]::${operation}($bytes, $null, 'CurrentUser')
       [Console]::Write([Convert]::ToBase64String($result))`,
      ],
      { input, encoding: "utf8", timeout: 10_000, windowsHide: true },
    );
    if (!output) throw new Error("Empty DPAPI result");
    return output;
  } catch {
    throw new Error(
      "Could not protect or open the local secret with Windows DPAPI for this account.",
    );
  }
}

function readRecord(io: StoreIO, file: string): string | null {
  try {
    if (!lstatSync(file).isFile())
      throw new Error("Local secret must be a regular file.");
    const flags = io.windows
      ? "r"
      : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
    const fd = io.open(file, flags);
    try {
      if (!fstatSync(fd).isFile())
        throw new Error("Local secret must be a regular file.");
      if (!io.windows) io.fchmod(fd, 0o600);
      return readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function openProtected(io: StoreIO, text: string) {
  return Buffer.from(dpapi(io, "Unprotect", text), "base64").toString("utf8");
}

function encrypted(text: string) {
  const record = JSON.parse(text) as { windows_protected?: unknown } | null;
  return typeof record?.windows_protected === "string"
    ? record.windows_protected
    : null;
}

function readSecret(io: StoreIO, file: string) {
  if (!lstatSync(file, { throwIfNoEntry: false })) return null;
  prepareDirectory(io, file);
  const text = readRecord(io, file);
  if (!io.windows || text === null) return text;
  const protectedText = encrypted(text);
  if (protectedText) return openProtected(io, protectedText);
  return io.lock(`${file}.secret-lock`, () => {
    // A writer may have replaced the old record before we acquired the lock.
    const legacy = readRecord(io, file);
    if (legacy === null) return null;
    const current = encrypted(legacy);
    if (current) return openProtected(io, current);
    replaceSecret(io, file, legacy);
    return legacy;
  });
}

function replaceSecret(
  io: StoreIO,
  file: string,
  text: string,
  commit: Commit = (replace) => replace(),
) {
  const contents = io.windows
    ? JSON.stringify({
        windows_protected: dpapi(
          io,
          "Protect",
          Buffer.from(text).toString("base64"),
        ),
      })
    : text;
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = io.open(temporary, "wx", 0o600);
    try {
      if (!io.windows) io.fchmod(fd, 0o600);
      writeFileSync(fd, contents);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    commit(() => renameSync(temporary, file));
  } finally {
    rmSync(temporary, { force: true });
  }
}

function writeSecret(io: StoreIO, file: string, text: string, commit?: Commit) {
  prepareDirectory(io, file);
  replaceSecret(io, file, text, (replace) => {
    const guarded = () => {
      if (io.windows) io.lock(`${file}.secret-lock`, replace);
      else replace();
    };
    if (commit) commit(guarded);
    else guarded();
  });
}

function removeSecret(io: StoreIO, file: string) {
  const remove = () => rmSync(file, { force: true });
  if (io.windows && lstatSync(file, { throwIfNoEntry: false }))
    io.lock(`${file}.secret-lock`, remove);
  else remove();
}

export function createSecretStore({
  platform = process.platform,
  env = process.env,
  execute = execFileSync,
  chmod = chmodSync,
  fchmod = fchmodSync,
  open = openSync,
  lock = withProcessLock,
}: SecretStoreIO = {}) {
  const io = {
    windows: platform === "win32",
    env,
    execute,
    chmod,
    fchmod,
    open,
    lock,
  };
  return {
    readSecretFile: (file: string) => readSecret(io, file),
    writeSecretFile: (file: string, text: string, commit?: Commit) =>
      writeSecret(io, file, text, commit),
    removeSecretFile: (file: string) => removeSecret(io, file),
  };
}

export const { readSecretFile, writeSecretFile, removeSecretFile } =
  createSecretStore();
