import {
  spawn as nativeSpawn,
  spawnSync as nativeSpawnSync,
} from "node:child_process";
import { win32 } from "node:path";
import crossSpawn from "cross-spawn";

function batchWithoutComSpec(command, args, options) {
  if (process.platform !== "win32" || process.env.ComSpec) return;
  const root = process.env.SystemRoot;
  if (!root || !win32.isAbsolute(root)) return;

  // Reuse cross-spawn's argv escaping. Its fallback cmd.exe would be looked
  // up on the child's PATH, which may intentionally omit system tools.
  const parsed = crossSpawn._parse(command, args, options);
  if (parsed.command !== "cmd.exe" || !parsed.options.windowsVerbatimArguments)
    return;
  const shell = win32.join(root, "System32", "cmd.exe");
  return [shell, parsed.args, { ...parsed.options, argv0: `"${shell}"` }];
}

// Run native executables with their argv intact and support Windows batch shims.
export function spawn(command, args, options) {
  const batch = batchWithoutComSpec(command, args, options);
  return batch
    ? nativeSpawn(...batch)
    : crossSpawn.spawn(command, args, options);
}

export function spawnSync(command, args, options) {
  const batch = batchWithoutComSpec(command, args, options);
  return batch
    ? nativeSpawnSync(...batch)
    : crossSpawn.sync(command, args, options);
}
