import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

const uuid = z.uuid();
const legacyHex = /^[0-9a-f]{32}$/i;
const pathOf = (home: string) => join(home, ".nodrail", "machine-id");

function legacyUuid(hex: string) {
  // Keep all but the version and variant bits. Inventory joins the dashless
  // telemetry ID to the UUID used by enrollment.
  const variant = (8 | (Number.parseInt(hex[16]!, 16) & 3)).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20)}`;
}

/** Read the enrollment ID without creating it, so plan stays read-only. */
export function enrollmentId(home: string): string | null {
  let id: string;
  try {
    id = readFileSync(pathOf(home), "utf8").trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (uuid.safeParse(id).success) return id;
  if (legacyHex.test(id)) return legacyUuid(id.toLowerCase());
  throw new Error(
    "Invalid Nodrail machine id in ~/.nodrail/machine-id. Remove it with `rm ~/.nodrail/machine-id` (PowerShell: `Remove-Item ~/.nodrail/machine-id`), then run `nodrail apply` again.",
  );
}

/** Publish a complete file in one step and return the winner of any race. */
export function saveMachineId(home: string, proposedId?: string): string {
  const existing = enrollmentId(home);
  if (existing !== null) return existing;
  const id = proposedId === undefined ? randomUUID() : uuid.parse(proposedId);
  const path = pathOf(home);
  const temporary = `${path}.${randomUUID()}.tmp`;
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32" && lstatSync(directory).isDirectory())
    chmodSync(directory, 0o700);
  const fd = openSync(temporary, "wx", 0o600);
  try {
    try {
      writeFileSync(fd, `${id}\n`);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(temporary, path);
      return id;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const winner = enrollmentId(home);
      if (winner !== null) return winner;
      throw new Error(
        "The Nodrail machine id changed. Run `nodrail apply` again.",
      );
    }
  } finally {
    rmSync(temporary);
  }
}

/** The same machine as enrollment, in the reporting contract's format. */
export function telemetryId(home: string) {
  return saveMachineId(home).replaceAll("-", "").toLowerCase();
}
