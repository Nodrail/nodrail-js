import type { Compiled } from "./compile-runs.ts";
import { pick, upward, type Path } from "./positions.ts";
import type { Collector } from "./rules-file.ts";

type Item = Pick<Compiled, "compiled" | "entry">;
export type Sections = Record<"rules" | "gates" | "budgets", Item[]>;
const sectionLabel = { rules: "Rule", gates: "Gate", budgets: "Budget" };

/** The fields of the file a compiled field comes from, first match wins. */
const fileFields: Record<string, Path[]> = {
  id: [["id"], ["rule"], ["gate"], ["budget"]],
  name: [["title"], ["rule"], ["gate"], ["budget"]],
  effect: [["effect"], ["otherwise"]],
  agentKey: [["agent"]],
  installationName: [["installation"]],
  toolKey: [["tool"], ["command"]],
  operationKey: [["operation"], ["command"]],
  resource: [["resource"], ["command"]],
  conditions: [["condition"]],
  expiresAt: [["expires"]],
  requires: [["requires"]],
  agent: [["step_agent"]],
  per: [["per"]],
  limit: [["tool_calls"], ["tokens"], ["usd"]],
  metric: [["tool_calls"], ["tokens"], ["usd"]],
  warnAt: [["warn_at"]],
};
/** Names inside a field that the file spells differently. */
const nestedNames: Record<string, string> = { verdicts: "verdict" };

/** Where a compiled field was written: the same path inside it, else the field. */
function fieldPaths(path: PropertyKey[]): Path[] {
  const [field, ...rest] = path;
  const nested = rest.map((key) =>
    typeof key === "string" ? (nestedNames[key] ?? key) : (key as number),
  );
  const bases = fileFields[String(field)] ?? [];
  // Conditions come out of macros and lists, so their indexes aren't the file's.
  if (field === "conditions") return bases;
  return bases.flatMap((base) => upward([...base, ...nested]));
}

/** A problem in the compiled document, reported where the file wrote it. */
export function reportSchemaIssues(
  issues: { path: PropertyKey[]; message: string }[],
  sections: Sections,
  fallback: string,
  collector: Collector,
) {
  for (const issue of issues) {
    const section = (
      typeof issue.path[0] === "string" && issue.path[0] in sections
        ? issue.path[0]
        : "rules"
    ) as keyof Sections;
    const index = typeof issue.path[1] === "number" ? issue.path[1] : null;
    const item = index === null ? undefined : sections[section][index];
    const field = issue.path.slice(2).join(".");
    collector.error(
      item
        ? pick(item.entry, fieldPaths(issue.path.slice(2)))
        : { file: fallback, line: 1, column: 1 },
      `${item ? `${sectionLabel[section]} "${item.compiled.name}"` : "Rules"}${field ? ` ${field}` : ""}: ${issue.message}`,
    );
  }
}
