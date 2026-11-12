import type { Collector, CompiledRule } from "./rules-file.ts";

export type Sections = Record<"rules" | "gates" | "budgets", CompiledRule[]>;
const sectionLabel = { rules: "Rule", gates: "Gate", budgets: "Budget" };

/** A problem in the compiled document, reported at the entry it came from. */
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
    const entry = index === null ? undefined : sections[section][index];
    const field = issue.path.slice(2).join(".");
    collector.error(
      entry
        ? { file: entry.source.file, line: entry.source.line, column: 1 }
        : { file: fallback, line: 1, column: 1 },
      `${entry ? `${sectionLabel[section]} "${entry.name}"` : "Rules"}${field ? ` ${field}` : ""}: ${issue.message}`,
    );
  }
}
