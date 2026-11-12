// The hook never lets an agent change the rules it enforces. Rules in the
// files can be wrong or missing; this holds whatever they say.
import { resolve } from "node:path";
import { CHANGING_FILE_OPERATIONS } from "./changes.ts";
import { canonicalPath, isWithin } from "./paths.ts";
import type { ActionDescriptor } from "./protocol.ts";

/** The rule files and folders the hook loaded, as file tools name paths. */
export function protectedPaths(paths: string[], cwd = process.cwd()) {
  return paths.map((path) => canonicalPath(resolve(cwd, path)));
}

/** Every path a file change touches. */
function targets(action: ActionDescriptor) {
  const { paths } = action.params as { paths?: unknown };
  if (action.operation === "file.patch" && Array.isArray(paths))
    return paths.filter((path): path is string => typeof path === "string");
  return [action.resource.id];
}

/**
 * The rules file or folder a file change would touch, or null. Writes, edits,
 * deletes, patches and notebook edits are all changes.
 */
export function touchedRules(
  action: ActionDescriptor,
  rules: readonly string[],
): string | null {
  if (
    action.tool !== "files" ||
    !CHANGING_FILE_OPERATIONS.has(action.operation)
  )
    return null;
  for (const target of targets(action))
    if (rules.some((rule) => isWithin(target, rule))) return target;
  return null;
}
