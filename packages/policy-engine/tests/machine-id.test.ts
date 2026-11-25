import { execFile } from "node:child_process";
import {
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
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { z } from "zod";
import { enrollmentId, saveMachineId, telemetryId } from "../src/machine-id";

function location() {
  const home = mkdtempSync(join(tmpdir(), "nodrail machine "));
  const directory = join(home, ".nodrail");
  return { home, directory, file: join(directory, "machine-id") };
}

test.each([
  ["1234567890AB0DEF3FEDCBA987654321", "12345678-90ab-4def-bfed-cba987654321"],
  [
    "12345678-90AB-7DEF-BFED-CBA987654321",
    "12345678-90AB-7DEF-BFED-CBA987654321",
  ],
])("enrollment and telemetry share the identity in %s", (stored, canonical) => {
  const { home, directory, file } = location();
  try {
    mkdirSync(directory);
    const contents = `${stored}\r\n`;
    writeFileSync(file, contents);
    expect(enrollmentId(home)).toBe(canonical);
    expect(telemetryId(home)).toBe(canonical.replaceAll("-", "").toLowerCase());
    expect(saveMachineId(home)).toBe(canonical);
    expect(readFileSync(file, "utf8")).toBe(contents);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("concurrent enrollment and telemetry writers use the same complete file", async () => {
  const { home, directory, file } = location();
  const run = promisify(execFile);
  const source = new URL("../src/machine-id.ts", import.meta.url).href;
  const child = `
    import { saveMachineId, telemetryId } from ${JSON.stringify(source)};
    const [role, home] = process.argv.slice(1);
    console.log(role === "telemetry" ? telemetryId(home) : saveMachineId(home));
  `;
  try {
    expect(enrollmentId(home)).toBeNull();
    const results = await Promise.allSettled(
      ["telemetry", "enrollment", "telemetry", "enrollment"].map((role) =>
        run(process.execPath, ["--input-type=module", "-e", child, role, home]),
      ),
    );
    const id = z.uuid().parse(readFileSync(file, "utf8").trim());
    const hex = id.replaceAll("-", "");
    expect(
      results.map((result) => {
        if (result.status === "rejected") throw result.reason;
        return result.value.stdout.trim();
      }),
    ).toEqual([hex, id, hex, id]);
    expect(readdirSync(directory)).toEqual(["machine-id"]);
    if (process.platform !== "win32") {
      expect(statSync(directory).mode & 0o777).toBe(0o700);
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
