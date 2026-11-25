import { execFileSync } from "node:child_process";
import type { SecretRef } from "./connections.ts";

/** Reads secrets by reference, where they are kept; never writes one. */

type Env = Record<string, string | undefined>;

const SECURITY = "/usr/bin/security";

const keychainArgs = (
  ref: { service: string; account?: string },
  value: boolean,
) => [
  "find-generic-password",
  "-s",
  ref.service,
  ...(ref.account ? ["-a", ref.account] : []),
  ...(value ? ["-w"] : []),
];

/** How a reference is named in messages: never with its value. */
export const secretName = (ref: SecretRef) =>
  "fromEnv" in ref
    ? ref.fromEnv
    : `Keychain ${ref.fromKeychain.service}${ref.fromKeychain.account ? `/${ref.fromKeychain.account}` : ""}`;

/** Whether the reference resolves here, without reading the secret. */
export function hasSecret(ref: SecretRef, env: Env) {
  if ("fromEnv" in ref) return (env[ref.fromEnv] ?? "") !== "";
  if (process.platform !== "darwin") return false;
  try {
    execFileSync(SECURITY, keychainArgs(ref.fromKeychain, false), {
      stdio: "ignore",
      timeout: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}

/** The secret's value; an error names the reference, never a value. */
export function secretValue(ref: SecretRef, env: Env, timeout = 10_000) {
  if ("fromEnv" in ref) {
    const value = env[ref.fromEnv];
    if (!value) throw new Error(`${ref.fromEnv} isn't set`);
    return value;
  }
  if (process.platform !== "darwin")
    throw new Error("Keychain references work on macOS only");
  try {
    return execFileSync(SECURITY, keychainArgs(ref.fromKeychain, true), {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout,
    }).replace(/\n$/, "");
  } catch {
    throw new Error(`${secretName(ref)} isn't in the Keychain`);
  }
}
