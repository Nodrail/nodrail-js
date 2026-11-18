import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stagingFolder } from "../../src/project/store.ts";
import { fileURLToPath, pathToFileURL } from "node:url";

// Node itself with tsx as its loader: .bin/tsx is a shell script, which
// Windows can't run directly.
const tsx = pathToFileURL(
  fileURLToPath(
    new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url),
  ),
).href;
const helper = fileURLToPath(new URL("./crashing-nodrail.ts", import.meta.url));

/**
 * Runs a real `nodrail` that dies at `step` (see crashing-nodrail.ts),
 * leaving whatever it left. Answers its exit status: 9 when it died.
 */
export const killed = (
  {
    cwd,
    home,
    env = {},
  }: { cwd: string; home: string; env?: Record<string, string> },
  step: string,
  ...argv: string[]
) =>
  spawnSync(process.execPath, ["--import", tsx, helper, ...argv], {
    cwd,
    // HOME on Unix, USERPROFILE on Windows: where nodrail stages writes.
    env: {
      ...process.env,
      ...env,
      HOME: home,
      USERPROFILE: home,
      CRASH_ON: step,
    },
    encoding: "utf8",
  }).status;

/**
 * Makes the project look held by another nodrail that is still running:
 * this test's own parent process stands in for it. Answers that pid.
 */
export function heldByAnother(place: { cwd: string; home: string }) {
  const folder = stagingFolder({ root: place.cwd, home: place.home });
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "owner"), String(process.ppid));
  return process.ppid;
}
