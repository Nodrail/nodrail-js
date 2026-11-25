import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ReadingFields } from "./outcome-readings.ts";

export type SharedBudgetClaim = {
  key: string;
  policyDigest: string;
  expiresAt: number;
  expiresTick: number;
  readings?: ReadingFields;
};

export type SettlementTarget = Pick<SharedBudgetClaim, "key" | "policyDigest">;

type StoredClaim = SettlementTarget & Pick<SharedBudgetClaim, "readings">;

export const settlementTargets = (
  claims: readonly SettlementTarget[],
): SettlementTarget[] =>
  claims.map(({ key, policyDigest }) => ({ key, policyDigest }));

function location(folder: string, key: string) {
  const parent = key.split("#", 1)[0]!;
  const directory = join(folder, "claims");
  const name = createHash("sha256").update(parent).digest("hex");
  return { directory, file: join(directory, name) };
}

/** Keep the exact claimed parts even if the decision sender gets no action IDs. */
export function rememberClaims(
  folder: string,
  claims: readonly SharedBudgetClaim[],
) {
  const { directory, file } = location(folder, claims[0]!.key);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stored = claims.map(({ key, policyDigest, readings }): StoredClaim => ({
    key,
    policyDigest,
    readings,
  }));
  writeFileSync(file, JSON.stringify(stored), {
    flag: "wx",
    mode: 0o600,
  });
  return () => rmSync(file, { force: true });
}

export function readClaims(folder: string, key: string): StoredClaim[] {
  try {
    return JSON.parse(
      readFileSync(location(folder, key).file, "utf8"),
    ) as StoredClaim[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export function forgetClaims(folder: string, key: string) {
  rmSync(location(folder, key).file, { force: true });
}
