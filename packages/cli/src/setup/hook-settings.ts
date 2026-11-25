import { readFileSync } from "node:fs";
import { join } from "node:path";

export type Json = Record<string, unknown>;

export const object = (value: unknown): Json | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : null;

export function json(path: string): Json | null {
  try {
    return object(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

export const textOf = (value: unknown) =>
  typeof value === "string" ? value : null;

/** Every hook command in a Claude Code settings object, by event. */
export function hooksIn(settings: Json | null) {
  const hooks = object(settings?.hooks) ?? {};
  return Object.entries(hooks).flatMap(([event, groups]) =>
    (Array.isArray(groups) ? groups : []).flatMap((group) => {
      const settings = object(group);
      const hooks: unknown[] = Array.isArray(settings?.hooks)
        ? settings.hooks
        : [];
      return hooks.map((hook) => ({
        event,
        matcher: textOf(settings?.matcher),
        command:
          textOf(object(hook)?.command) ?? textOf(object(hook)?.type) ?? "?",
      }));
    }),
  );
}

export function preToolCommands(root: string, path: string) {
  return hooksIn(json(join(root, path)))
    .filter(({ event }) => event === "PreToolUse")
    .map(({ command }) => command);
}
