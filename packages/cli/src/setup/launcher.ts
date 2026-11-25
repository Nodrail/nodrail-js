import { accessSync, constants, realpathSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import type { Env } from "../config.ts";
import { onPath } from "./tools.ts";

// The installed CLI is a self-contained Node entry point. Resolve symlinks
// now so the host runs the same build even with a different PATH.
const entry = fileURLToPath(import.meta.url);
const bundled = basename(entry) === "nodrail.mjs";
const cliEntry = bundled ? realpathSync(entry) : null;

export const shellArg = (text: string) =>
  "'" + text.replaceAll("'", "'\\''") + "'";

export const launcher = cliEntry
  ? { command: process.execPath, args: [cliEntry] }
  : { command: "nodrail", args: [] as string[] };

export const launchShell = cliEntry
  ? [launcher.command, ...launcher.args].map(shellArg).join(" ")
  : launcher.command;

export const launcherTail = (command: string) =>
  command.replace(
    /^nodrail |^'(?:[^']|'\\'')*' '(?:[^']|'\\'')*nodrail\.mjs' /,
    "",
  );

export function launcherCheck(env: Env) {
  if (!cliEntry) return onPath("nodrail", env, "the policy hook runs it");
  try {
    accessSync(launcher.command, constants.X_OK);
    accessSync(cliEntry, constants.R_OK);
    return {
      name: "nodrail",
      ok: true,
      detail: `hooks, MCP wrappers and connections declared as command: nodrail use ${launchShell}; keep these files in place`,
    };
  } catch {
    return {
      name: "nodrail",
      ok: false,
      detail: `can't run ${launchShell}; reinstall the CLI and retry`,
    };
  }
}
