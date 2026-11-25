import { accessSync, constants } from "node:fs";
import { posix, win32 } from "node:path";
import type { Env } from "../config.ts";
import { spawnSync } from "../spawn.js";
import type { Check } from "./plan.ts";

/** The host tools a setup needs, found on PATH and checked by version. */

const windows = process.platform === "win32";
const { delimiter, join } = windows ? win32 : posix;

/** The first executable called `name` on PATH, or null; on Windows, with PATHEXT. */
export function findOnPath(name: string, env: Env) {
  const endings = windows
    ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  for (const folder of (env.PATH ?? env.Path ?? "")
    .split(delimiter)
    .filter(Boolean))
    for (const ending of endings) {
      const path = join(folder, name + ending);
      try {
        accessSync(path, constants.X_OK);
        return path;
      } catch {
        // Not here.
      }
    }
  return null;
}

export function onPath(name: string, env: Env, why: string): Check {
  const path = findOnPath(name, env);
  return path
    ? { name, ok: true, detail: path }
    : { name, ok: false, detail: `not on PATH; ${why}` };
}

const parts = (version: string) => version.split(".").map(Number);
export function atLeast(version: string, minimum: string) {
  const [a, b] = [parts(version), parts(minimum)];
  for (let index = 0; index < 3; index++)
    if ((a[index] ?? 0) !== (b[index] ?? 0))
      return (a[index] ?? 0) > (b[index] ?? 0);
  return true;
}

/** A tool on PATH at `minimum` or later, by its `--version`. */
export function versionCheck(
  name: string,
  minimum: string,
  install: string,
  env: Env,
): Check {
  const path = findOnPath(name, env);
  if (path === null)
    return { name, ok: false, detail: `not on PATH; ${install}` };
  const result = spawnSync(path, ["--version"], {
    encoding: "utf8",
    env: env as NodeJS.ProcessEnv,
    timeout: 15_000,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.error || result.status !== 0)
    return { name, ok: false, detail: `${path} --version failed` };
  const output = result.stdout;
  const version = /\d+\.\d+\.\d+/.exec(output)?.[0];
  if (!version)
    return { name, ok: false, detail: `unexpected version: ${output.trim()}` };
  return atLeast(version, minimum)
    ? { name, ok: true, detail: version }
    : { name, ok: false, detail: `${version}; needs ${minimum} or later` };
}
