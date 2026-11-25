import {
  mkdirSync,
  openSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  readHostCredential,
  removeHostCredential,
  writeHostCredential,
} from "../src/host-credentials.ts";
import { createSecretStore, writeSecretFile } from "../src/secret-store.ts";

import { fakeDpapi } from "./support/fake-dpapi.ts";

const binding = {
  origin: "https://nodrail.example",
  workspace: "fixture",
  environment: "dev",
  projectId: "example",
};
const old = {
  ...binding,
  installationId: "fixture",
  credential: `ndr_123456789abc_${"X".repeat(43)}`,
};
const next = { ...old, credential: `ndr_123456789abd_${"Y".repeat(43)}` };
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "nodrail-host-"));
});
afterEach(() => {
  rmSync(home, { force: true, recursive: true });
});

test.each(["darwin", "linux", "win32"] as const)(
  "%s fences credential replacements by generation and removes the binding",
  async (platform) => {
    const store = createSecretStore({
      platform,
      execute: fakeDpapi,
      chmod: vi.fn(),
      fchmod: vi.fn(),
      open: (path, flags, mode) =>
        openSync(path, typeof flags === "number" ? "r" : flags, mode),
    });
    const commit = (replace: () => void) => replace();
    await writeHostCredential(
      home,
      old,
      { commit, previousGeneration: undefined },
      store,
    );
    await expect(
      writeHostCredential(
        home,
        next,
        {
          commit,
          previousGeneration: "0".repeat(12),
        },
        store,
      ),
    ).rejects.toThrow("credential generation changed");
    expect(await readHostCredential(home, binding, store)).toEqual(old);
    await writeHostCredential(
      home,
      next,
      {
        commit,
        previousGeneration: "123456789abc",
      },
      store,
    );
    expect(await readHostCredential(home, binding, store)).toEqual(next);
    removeHostCredential(home, binding, store);
    await expect(readHostCredential(home, binding, store)).resolves.toBeNull();
  },
);

test("a corrupt or incorrectly bound record never supplies a credential", async () => {
  await writeHostCredential(home, old);
  const folder = join(home, ".nodrail", "hosts");
  const [name] = readdirSync(folder);
  const file = join(folder, name!);
  for (const patch of [
    null,
    { ...old, origin: "https://other.example" },
    { ...old, workspace: "other" },
    { ...old, environment: "other" },
    { ...old, projectId: "other" },
    { ...old, credential: undefined },
    { ...old, credential: "bad" },
    { ...old, installationId: undefined },
  ]) {
    writeSecretFile(file, JSON.stringify(patch));
    expect(await readHostCredential(home, binding)).toBeNull();
  }
  writeFileSync(file, "{");
  expect(await readHostCredential(home, binding)).toBeNull();
  rmSync(file);
  mkdirSync(file);
  await expect(readHostCredential(home, binding)).rejects.toThrow(
    "regular file",
  );
});

test("a credential disappearing during a read is treated as absent", async () => {
  const store = createSecretStore();
  const missing = Object.assign(new Error("disappeared"), { code: "ENOENT" });
  await expect(
    readHostCredential(home, binding, {
      ...store,
      readSecretFile: () => {
        throw missing;
      },
    }),
  ).resolves.toBeNull();
});
