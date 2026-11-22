// S02: an Agent's brief, bound to its shape with how it is read, and the
// checks a header brief adds (flat, aliases), shared with header receipts.
import type { BriefDecl } from "./grammar-agent.ts";
import { bind, type Registry } from "./registry.ts";
import type { Path } from "./resolve.ts";
import type { ResolvedShape } from "./types.ts";

/**
 * A brief as one form: its shape and how it is read. A fenced brief has no
 * options, so a brief named by its shape keeps the digest it always had.
 */
type Briefing = {
  shape: string;
  options: { format?: "header"; header?: { aliases: Record<string, string> } };
};

export function briefOf(brief: BriefDecl): Briefing {
  if (typeof brief === "string") return { shape: brief, options: {} };
  if (brief.format === "fenced") return { shape: brief.shape, options: {} };
  const header = { aliases: brief.header?.aliases ?? {} };
  return { shape: brief.shape, options: { format: "header", header } };
}

// S02
export function bindBrief(
  registry: Registry,
  agent: string,
  brief: Briefing,
  at: Path,
) {
  const shape = bind(
    registry,
    {
      surface: "S02",
      name: `brief:${agent}`,
      shape: brief.shape,
      options: brief.options,
    },
    at,
  );
  if (!shape) return;
  if (Object.hasOwn(shape.properties, "agent"))
    registry.report(
      "reserved-name",
      at,
      "agent is the dispatch's reserved identity; rename the property",
    );
  if (brief.options.format !== "header") return;
  const nested = nestedProperty(shape);
  if (nested)
    registry.report(
      "header-nesting",
      [...at, "format"],
      `A header brief is flat; ${nested} isn't a single value`,
    );
  checkAliases(registry, shape, brief.options.header?.aliases ?? {}, at);
}

/** The first top-level property that isn't a single value, if any. */
export const nestedProperty = (shape: ResolvedShape) =>
  Object.entries(shape.properties).find(
    ([, p]) => p.type === "object" || p.type === "list",
  )?.[0];

/** Each alias names one top-level property, and no two name the same. */
export function checkAliases(
  registry: Registry,
  shape: ResolvedShape,
  aliases: Record<string, string>,
  at: Path,
) {
  const entries = Object.entries(aliases);
  const targets = entries.map(([, target]) => target);
  for (const [key, target] of entries)
    if (
      !Object.hasOwn(shape.properties, target) ||
      targets.indexOf(target) !== targets.lastIndexOf(target)
    )
      registry.report(
        "unknown-reference",
        [...at, "header", "aliases", key],
        `Alias ${key} must name one top-level property, once`,
      );
}
