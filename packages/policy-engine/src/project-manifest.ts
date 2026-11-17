import { z } from "zod";

/** A project's composition: what it imports, in order, and with what. */
export const PROJECT_KIND = "nodrail.project/v1";
/** A packaged module's composition, inside a catalog. */
export const MODULE_KIND = "nodrail.module/v1";

/** `owner/name`, as GitHub spells it. Never a pattern or a path. */
const repository = z
  .string()
  .regex(
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/,
    "Expected an exact repository, like acme/widgets",
  );

/** The types a binding can have, each with the check its values pass. */
export const parameterTypes = { repository } as const;
export type ParameterType = keyof typeof parameterTypes;

/**
 * A valid value of each type that names nothing real. It fills a missing
 * value only to check that the rest of a project compiles around it.
 */
export const standIns: Record<ParameterType, string> = {
  repository: "configuration-required/repository",
};

const bindingValue = z.string().max(200);

const importEntry = z.union([
  z.string().min(1).max(300),
  z
    .object({
      ref: z.string().min(1).max(300),
      with: z.record(z.string(), bindingValue).optional(),
    })
    .strict(),
]);

/** nodrail.yaml, or a local manifest it imports. */
export const projectManifest = z
  .object({
    kind: z.literal(PROJECT_KIND),
    imports: z.array(importEntry).max(200).default([]),
  })
  .strict();

const parameter = z
  .object({
    type: z.enum(Object.keys(parameterTypes) as [ParameterType]),
    description: z.string().max(500).optional(),
  })
  .strict();

const fileRef = z.string().regex(/^[A-Za-z0-9._/-]+\.ya?ml$/);
const markdownRef = z.string().regex(/^[A-Za-z0-9._/-]+\.md$/);

/** A catalog module's own manifest, or one nested inside the module. */
export const moduleManifest = z
  .object({
    kind: z.literal(MODULE_KIND),
    name: z.string().max(120).optional(),
    version: z.string().max(40).optional(),
    description: z.string().max(1000).optional(),
    parameters: z.record(z.string(), parameter).optional(),
    imports: z.array(fileRef).max(100).default([]),
    /** Stable role ids the policy names, with what each one does. */
    roles: z.record(z.string(), z.string().max(500)).optional(),
    /** Guidance shipped with the module. Installing it grants nothing. */
    skills: z.array(markdownRef).max(20).optional(),
  })
  .strict();

export type ProjectImport = { ref: string; with?: Record<string, string> };
export type ModuleManifest = z.infer<typeof moduleManifest>;

/** One import entry, written either way, as an object. */
export const importOf = (entry: z.infer<typeof importEntry>): ProjectImport =>
  typeof entry === "string" ? { ref: entry } : entry;

/** Why a binding's value can't be used, or null. */
export function bindingProblem(type: ParameterType, value: string) {
  const checked = parameterTypes[type].safeParse(value);
  return checked.success ? null : (checked.error.issues[0]?.message ?? "");
}
