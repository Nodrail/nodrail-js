import {
  chmodSync,
  constants,
  openSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, win32 } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createSecretStore } from "../src/secret-store.ts";
import { fakeDpapi } from "./support/fake-dpapi.ts";

const fixture = '{"value":"sample-private-record"}';

const execute = vi.fn(fakeDpapi);
const windowsStore = (env = {}) =>
  createSecretStore({ platform: "win32", execute, env });

let home: string;
let file: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "nodrail-store-"));
  file = join(home, ".nodrail", "hosts", "test.json");
});
afterEach(() => {
  execute.mockReset();
  rmSync(home, { force: true, recursive: true });
});

test("Windows migrates a plaintext record once and uses the same store to update and remove it", () => {
  execute.mockImplementation(fakeDpapi);
  const { readSecretFile, writeSecretFile, removeSecretFile } = windowsStore();
  expect(readSecretFile(file)).toBeNull();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, fixture);
  expect(readSecretFile(file)).toBe(fixture);
  const envelope = readFileSync(file, "utf8");
  expect(JSON.parse(envelope)).toEqual({
    windows_protected: expect.any(String),
  });
  expect(envelope).not.toContain("sample-private-record");
  expect(readSecretFile(file)).toBe(fixture);
  expect(readFileSync(file, "utf8")).toBe(envelope);
  writeSecretFile(file, fixture, (commit) => {
    const staged = readdirSync(dirname(file)).find((name) =>
      name.endsWith(".tmp"),
    );
    expect(staged).toBeDefined();
    const contents = readFileSync(join(dirname(file), staged!), "utf8");
    expect(JSON.parse(contents)).toEqual({
      windows_protected: expect.any(String),
    });
    expect(contents).not.toContain("sample-private-record");
    commit();
  });
  expect(readSecretFile(file)).toBe(fixture);
  removeSecretFile(file);
  expect(readSecretFile(file)).toBeNull();
  removeSecretFile(file);
  expect(readdirSync(dirname(file))).toEqual([]);
});

test("DPAPI failure stops both migration and replacement, and an unreadable envelope stays intact", () => {
  execute.mockImplementation(fakeDpapi);
  const { readSecretFile, writeSecretFile } = windowsStore({
    SystemRoot: "D:\\Windows",
  });
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, fixture);
  execute.mockImplementation(() => {
    throw new Error("no Windows profile");
  });
  expect(() => readSecretFile(file)).toThrow("Windows DPAPI");
  expect(() => writeSecretFile(file, "{}")).toThrow("Windows DPAPI");
  expect(readFileSync(file, "utf8")).toBe(fixture);
  expect(execute.mock.calls[0]?.[0]).toBe(
    win32.join(
      "D:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
  );
  execute.mockImplementation(fakeDpapi);
  writeSecretFile(file, fixture);
  const envelope = readFileSync(file, "utf8");
  execute.mockReturnValue("");
  expect(() => readSecretFile(file)).toThrow("Windows DPAPI");
  expect(readFileSync(file, "utf8")).toBe(envelope);
  expect(readdirSync(dirname(file))).toEqual(["test.json"]);
});

test.skipIf(process.platform === "win32")(
  "POSIX repairs existing permissions, rejects symlinks, and cleans up an uncommitted write",
  () => {
    const { readSecretFile, writeSecretFile, removeSecretFile } =
      createSecretStore();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, fixture);
    chmodSync(file, 0o644);
    expect(readSecretFile(file)).toBe(fixture);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(() =>
      writeSecretFile(file, "{}", () => {
        throw new Error("lost ownership");
      }),
    ).toThrow("lost ownership");
    expect(readSecretFile(file)).toBe(fixture);
    expect(readdirSync(dirname(file))).toEqual(["test.json"]);
    const link = join(dirname(file), "link");
    symlinkSync(file, link);
    expect(() => readSecretFile(link)).toThrow("regular file");
    const redirected = join(home, ".nodrail", "redirected");
    symlinkSync(dirname(file), redirected);
    expect(() => writeSecretFile(join(redirected, "new"), "{}")).toThrow(
      "real directory",
    );
    removeSecretFile(file);
    expect(readSecretFile(file)).toBeNull();
  },
);

test.each(["darwin", "linux"] as const)(
  "%s opens private files without following links and repairs modes",
  (platform) => {
    const chmod = vi.fn();
    const fchmod = vi.fn();
    const open = vi.fn<typeof openSync>((path, flags, mode) =>
      openSync(path, typeof flags === "number" ? "r" : flags, mode),
    );
    const store = createSecretStore({ platform, chmod, fchmod, open, execute });
    store.writeSecretFile(file, fixture);
    expect(store.readSecretFile(file)).toBe(fixture);
    expect(open).toHaveBeenCalledWith(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    expect(chmod).toHaveBeenCalledWith(join(home, ".nodrail"), 0o700);
    expect(chmod).toHaveBeenCalledWith(dirname(file), 0o700);
    expect(fchmod.mock.calls.map(([, mode]) => mode)).toEqual([0o600, 0o600]);
    expect(execute).not.toHaveBeenCalled();
    store.removeSecretFile(file);
    expect(store.readSecretFile(file)).toBeNull();
  },
);

test.each(["deleted", "already protected"] as const)(
  "Windows rechecks a legacy record under the lock when it was %s",
  (result) => {
    execute.mockImplementation(fakeDpapi);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, fixture);
    const store = createSecretStore({
      platform: "win32",
      execute,
      lock: (folder, work) => {
        expect(folder).toBe(`${file}.secret-lock`);
        if (result === "deleted") rmSync(file);
        else windowsStore().writeSecretFile(file, '{"new":true}');
        return work();
      },
    });
    expect(store.readSecretFile(file)).toBe(
      result === "deleted" ? null : '{"new":true}',
    );
  },
);

test("a record removed before open is absent and other open failures propagate", () => {
  const open = vi.fn<typeof openSync>();
  const store = createSecretStore({ platform: "linux", open, chmod: vi.fn() });
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, fixture);
  const failure = Object.assign(new Error("failed to open"), {
    code: "ENOENT",
  });
  open.mockImplementation(() => {
    throw failure;
  });
  expect(store.readSecretFile(file)).toBeNull();
  failure.code = "EACCES";
  expect(() => store.readSecretFile(file)).toThrow(failure);
});
