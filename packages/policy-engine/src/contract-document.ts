// What a version 3 policy document carries for declared contracts: each
// agent's pinned receipt contract and the compiled `where` conditions of
// gate requirements. The resolved shape is checked against its digest, so
// a document can't pair one contract's digest with another's shape.
import { z } from "zod";
import { contractDigest } from "./shapes/digest.ts";
import { LIMITS } from "./shapes/limits.ts";
import {
  CLASSIFICATIONS,
  ROLES,
  type ResolvedProperty,
} from "./shapes/types.ts";

export const contractDigestText = z.string().regex(/^sha256:[0-9a-f]{64}$/);

const pathPart = z.string().min(1).max(63);
const scalar = z.union([
  z.string().max(1000),
  z.number().finite(),
  z.boolean(),
]);
const bound = z.union([z.number().finite(), z.string().max(10)]).nullable();

const conditionOf = (path: z.ZodType<string[]>) =>
  z.union([
    z.strictObject({ path, op: z.literal("eq"), value: scalar }),
    z.strictObject({ path, op: z.literal("range"), min: bound, max: bound }),
    z.strictObject({
      path,
      op: z.literal("in"),
      values: z
        .array(z.union([z.string().max(1000), z.number().finite()]))
        .min(1)
        .max(LIMITS.values),
    }),
  ]);

export const compiledCondition = conditionOf(
  z.array(pathPart).min(1).max(LIMITS.depth),
);

/**
 * A rule's or gate's `where` (C02): its paths start with the root they
 * read, `input` or `brief`, so they run one level deeper than a shape's.
 */
export const ruleCondition = conditionOf(
  z
    .array(pathPart)
    .min(2)
    .max(LIMITS.depth + 1)
    .refine((path) => path[0] === "input" || path[0] === "brief", {
      message: "A rule's condition reads input or brief",
    }),
);

const common = {
  optional: z.boolean(),
  for: z.string().max(LIMITS.forText).nullable(),
  report: z.boolean().nullable(),
  classification: z.enum(CLASSIFICATIONS).nullable(),
  role: z.enum(ROLES).nullable(),
};
const count = z.number().int().min(0);
const limit = z.number().finite().nullable();

/** A resolved property, as compiled documents and Cloud carry it. */
export const resolvedProperty: z.ZodType<ResolvedProperty> = z.lazy(() =>
  z.union([
    z.strictObject({
      ...common,
      type: z.literal("string"),
      min: count,
      max: count,
    }),
    z.strictObject({
      ...common,
      type: z.literal("enum"),
      values: z.array(z.string().max(64)).min(1).max(LIMITS.values),
    }),
    z.strictObject({
      ...common,
      type: z.enum(["integer", "number"]),
      min: limit,
      max: limit,
      unit: z.string().max(32).nullable(),
    }),
    z.strictObject({ ...common, type: z.literal("boolean") }),
    z.strictObject({
      ...common,
      type: z.literal("date"),
      min: z.string().max(10).nullable(),
      max: z.string().max(10).nullable(),
    }),
    z.strictObject({
      ...common,
      type: z.literal("list"),
      min: count,
      max: count,
      of: resolvedProperty,
    }),
    z.strictObject({
      ...common,
      type: z.literal("object"),
      properties: z.record(z.string().max(63), resolvedProperty),
    }),
  ]),
);

/** A resolved shape, as compiled documents and Cloud carry it. */
export const resolvedShape = z.strictObject({
  for: z.string().max(LIMITS.forText).nullable(),
  properties: z.record(z.string().max(63), resolvedProperty),
});

/** One agent's receipt contract, as the hook reads receipts with it. */
export const receiptContract = z
  .strictObject({
    name: z.string().min(1).max(63),
    format: z.enum(["fenced", "header"]),
    header: z
      .strictObject({
        title: z.string().min(1).max(64),
        aliases: z.record(z.string().max(32), z.string().max(63)),
        mode_prefix: z.boolean(),
      })
      .nullable(),
    contract: contractDigestText,
    shape: resolvedShape,
  })
  .refine(
    (receipt) => (receipt.format === "header") === (receipt.header !== null),
    {
      path: ["header"],
      message: "A header receipt, and only one, has header options",
    },
  )
  .refine(
    (receipt) => contractDigest("shape", receipt.shape) === receipt.contract,
    {
      path: ["contract"],
      message: "The contract digest isn't the shape's",
    },
  );

const pinned = <T extends { contract: string; shape: unknown }>(value: T) =>
  contractDigest("shape", value.shape as never) === value.contract;
const pinnedIssue = {
  path: ["contract"],
  message: "The contract digest isn't the shape's",
};

/** One agent's brief contract (S02), as the hook reads a dispatch's brief with it. */
export const briefContract = z
  .strictObject({
    name: z.string().min(1).max(63),
    format: z.enum(["fenced", "header"]),
    aliases: z.record(z.string().max(32), z.string().max(63)).nullable(),
    contract: contractDigestText,
    shape: resolvedShape,
  })
  .refine((brief) => (brief.format === "header") === (brief.aliases !== null), {
    path: ["aliases"],
    message: "A header brief, and only one, has aliases",
  })
  .refine(pinned, pinnedIssue);

/** One operation's declared input (S03), checked before the provider is called. */
export const inputContract = z
  .strictObject({
    name: z.string().regex(/^input:[a-z0-9_-]{1,64}\.[a-z0-9_-]{1,128}$/),
    contract: contractDigestText,
    shape: resolvedShape,
  })
  .refine(pinned, pinnedIssue);
