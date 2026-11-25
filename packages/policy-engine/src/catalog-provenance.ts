import { z } from "zod";
import type { CompiledRule } from "./rules-file.ts";

const marker = "# Nodrail catalog rule IDs: ";
const section = /^# ── (.+)$/;

export const catalogRuleMarker = (ids: string[]) =>
  ids.length ? `${marker}${JSON.stringify(ids)}\n` : "";

export function catalogRuleIds(text: string, rules: CompiledRule[]) {
  const lines = text.split(/\r?\n/);
  const explicit = lines.find((line) => line.startsWith(marker));
  if (explicit) {
    try {
      return new Set(
        z.array(z.string()).parse(JSON.parse(explicit.slice(marker.length))),
      );
    } catch {
      return new Set<string>();
    }
  }
  let catalog = false;
  const isCatalog = lines.map((line) => {
    const [, source] = section.exec(line) ?? [];
    if (source) catalog = source.startsWith("@");
    return catalog;
  });
  return new Set(
    rules
      .filter(({ source }) => isCatalog[source.line - 1])
      .map(({ id }) => id),
  );
}
