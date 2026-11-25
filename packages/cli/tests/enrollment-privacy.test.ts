import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readHostCredential,
  writeHostCredential,
} from "@nodrail/policy-engine/command-line";
import { expect, test, vi } from "vitest";
import { configPath, resolveToken, saveToken } from "../src/config.ts";
import { stagingFolder } from "../src/project/store.ts";
import {
  appliedEnrollments,
  rememberIntent,
} from "../src/setup/applied-enrollment.ts";

const intent = {
  origin: "https://nodrail.example",
  workspace: "acme",
  environment: "development",
  projectId: "6f1c2a8e-5b7d-4e0f-9a6c-1d2e3f405162",
  credential: `ndr_123456789abc_${"S".repeat(43)}`,
};
const host = {
  ...intent,
  installationId: "6f1c2a8e-5b7d-4e0f-9a6c-1d2e3f405163",
};
const token = `ndc_${"s".repeat(43)}`;

function records(home: string) {
  const place = { root: home, home };
  const applied = join(
    home,
    ".nodrail",
    "applied",
    `${stagingFolder(place)
      .split(/[\\\\/]/)
      .at(-1)}.json`,
  );
  const key = createHash("sha256")
    .update(
      JSON.stringify([
        intent.origin,
        intent.workspace,
        intent.environment,
        intent.projectId,
      ]),
    )
    .digest("hex");
  const active = join(home, ".nodrail", "hosts", `${key}.json`);
  return [
    {
      file: configPath(home),
      value: { tokens: { [intent.origin]: token } },
      read: () => resolveToken({}, home, intent.origin),
      expected: token,
      write: () => saveToken(home, intent.origin, token),
    },
    {
      file: applied,
      value: [intent],
      read: () => appliedEnrollments(place),
      expected: [intent],
      write: () => rememberIntent(place, intent, true),
    },
    {
      file: active,
      value: host,
      read: () => readHostCredential(home, intent),
      expected: host,
      write: () => writeHostCredential(home, host),
    },
  ];
}

function plantLegacy(home: string) {
  const directory = join(home, ".nodrail");
  for (const path of [
    directory,
    join(directory, "applied"),
    join(directory, "hosts"),
  ]) {
    mkdirSync(path);
    if (process.platform !== "win32") chmodSync(path, 0o755);
  }
  for (const { file, value } of records(home)) {
    writeFileSync(file, JSON.stringify(value));
    if (process.platform !== "win32") chmodSync(file, 0o644);
  }
}

test.skipIf(process.platform === "win32")(
  "every credential reader fixes legacy POSIX modes",
  async () => {
    const home = mkdtempSync(join(tmpdir(), "nodrail-private-"));
    try {
      plantLegacy(home);
      for (const { file, expected, read } of records(home)) {
        expect(await read()).toEqual(expected);
        expect(statSync(file).mode & 0o777).toBe(0o600);
      }
      for (const folder of [".nodrail", ".nodrail/applied", ".nodrail/hosts"])
        expect(statSync(join(home, folder)).mode & 0o777).toBe(0o700);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== "win32")(
  "all three legacy credentials migrate to per-user DPAPI and remain readable",
  async () => {
    const home = mkdtempSync(join(tmpdir(), "nodrail-dpapi-"));
    try {
      plantLegacy(home);
      for (const { file, expected, read, write } of records(home)) {
        expect(await read()).toEqual(expected);
        expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
          windows_protected: expect.any(String),
        });
        await write();
        expect(readFileSync(file, "utf8")).not.toMatch(/ndr_|ndc_/);
        expect(await read()).toEqual(expected);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
  60_000,
);

test.skipIf(process.platform !== "win32")(
  "DPAPI failure never creates a plaintext credential",
  async () => {
    const home = mkdtempSync(join(tmpdir(), "nodrail-no-dpapi-"));
    try {
      vi.stubEnv("SystemRoot", join(home, "missing"));
      for (const { file, write } of records(home)) {
        await expect(Promise.resolve().then(write)).rejects.toThrow(
          "Windows DPAPI",
        );
        expect(() => statSync(file)).toThrow();
      }
      expect(readdirSync(join(home, ".nodrail", "hosts"))).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    }
  },
);
