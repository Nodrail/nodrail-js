// Agent resources' contract slots (S01 selection, S02), in the grammar of
// dialect 1: `spec.receipt` picks a receipt, `spec.brief` the brief the
// agent is started with. Kept apart from grammar.ts for size only.
import { z } from "zod";
import { agentRef, headerKey, propertyName, shapeName } from "./grammar.ts";

/**
 * S02: the brief an Agent is started with. A shape name reads a fenced
 * `nodrail-brief` block in the dispatch prompt; `format: header` is the
 * explicit bridge for flat `key: value` lines (`issue: ENG-1`, `Budget: 80`),
 * with aliases mapping a line key to a top-level property.
 */
export const briefDecl = z.union([
  shapeName,
  z
    .strictObject({
      shape: shapeName,
      format: z.enum(["fenced", "header"]).default("fenced"),
      header: z
        .strictObject({ aliases: z.record(headerKey, propertyName).optional() })
        .optional(),
    })
    .refine((brief) => brief.format === "header" || !brief.header, {
      path: ["header"],
      message: "Only a format: header brief has a header",
    }),
]);
export type BriefDecl = z.infer<typeof briefDecl>;

/** An Agent resource's contract slots; the rest belongs to project-resources.ts. */
export const agentResource = z
  .object({
    kind: z.literal("Agent"),
    metadata: z.object({ name: agentRef }).loose(),
    spec: z
      .object({ receipt: shapeName.optional(), brief: briefDecl.optional() })
      .loose()
      .prefault({}),
  })
  .loose();
