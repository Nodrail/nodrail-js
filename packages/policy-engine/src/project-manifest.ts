import { z } from "zod";
import { agentConnectionsField, connectionsField } from "./connections.ts";
import { agentPluginsField, pluginsField } from "./plugins.ts";
import { connectField } from "./connect-schema.ts";
import { telemetryField } from "./telemetry-schema.ts";

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

/** The hosts `nodrail plan` and `nodrail apply` can set up. */
export const RUNTIMES = ["claude-code", "codex", "copilot"] as const;
export type Runtime = (typeof RUNTIMES)[number];

/**
 * A resource's name: the agent name hosts and runs use, already in the form
 * `agentName` gives, so a rule, a gate and the host all spell it one way.
 */
export const resourceName = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9_-]{0,62}$/,
    "Lowercase letters, digits, - and _, starting with a letter or digit",
  );

/** A file or folder in the project, written from the file that names it. */
export const localRef = z
  .string()
  .max(300)
  .regex(/^\.\.?\/[A-Za-z0-9._/-]*$/, "A path that starts with ./");

const exactVersion = z
  .string()
  .regex(/^\d+\.\d+\.\d+$/, "An exact version, such as 2.1.328");

/**
 * The exact versions the workspace was tested with. `plan` compares them
 * with what runs here and calls any other version unverified, not wrong.
 */
export const testedField = z
  .object({
    nodrail: exactVersion.optional(),
    node: exactVersion.optional(),
    "claude-code": exactVersion.optional(),
    codex: exactVersion.optional(),
    copilot: exactVersion.optional(),
  })
  .strict();
export type Tested = z.infer<typeof testedField>;

/**
 * Observation: by default, at each session start, counts only. `names`
 * also records the names of what nodrail doesn't manage, which says what
 * tools a person uses: so it's the project's choice to make.
 */
export const observeField = z
  .object({
    names: z.boolean().optional(),
    sessionStart: z.boolean().optional(),
  })
  .strict();

/** What nodrail.yaml alone may say: the setup `plan` and `apply` make. */
export const setupFields = {
  /**
   * The project's stable id for reports: the same in every clone and after
   * a rename, different for an unrelated project of the same name. Make one
   * once (`uuidgen`) and commit it; a fork that is its own project gets a
   * new one.
   */
  id: z.uuid().optional(),
  runtime: z.enum(RUNTIMES).optional(),
  /** Hosts one file can set up; `--runtime` picks one when there are two. */
  runtimes: z.array(z.enum(RUNTIMES)).min(1).max(RUNTIMES.length).optional(),
  /** The Team to start; optional when the resources hold one. */
  team: resourceName.optional(),
  /** Resource files, or folders whose .yaml files are all resources. */
  resources: z.union([localRef, z.array(localRef).max(50)]).optional(),
  start: z.boolean().optional(),
  /** MCP servers the host starts, and how the hook reads their calls. */
  connections: connectionsField.optional(),
  /** Which agents may use which connections; without it, every member. */
  agentConnections: agentConnectionsField.optional(),
  /** Plugins in the project each host loads, and their servers' operations. */
  plugins: pluginsField.optional(),
  /** Which agents may use which plugins; without it, every member. */
  agentPlugins: agentPluginsField.optional(),
  /** Where Nodrail sends each decision, over OpenTelemetry. */
  telemetry: telemetryField.optional(),
  /** The exact versions this workspace was tested with (proposed). */
  tested: testedField.optional(),
  /** What `nodrail observe` records, and when it runs (preview). */
  observe: observeField.optional(),
  /** The Nodrail this project is connected to, and who decides. */
  connect: connectField.optional(),
};

/** nodrail.yaml, or a local manifest it imports. */
export const projectManifest = z
  .object({
    kind: z.literal(PROJECT_KIND),
    imports: z.array(importEntry).max(200).default([]),
    ...setupFields,
  })
  .strict();
export type ProjectManifest = z.infer<typeof projectManifest>;

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

/** The first field a manifest gets wrong, and why. */
export function invalidField(
  issues: {
    path: PropertyKey[];
    message: string;
    code?: string;
    keys?: string[];
  }[],
) {
  const issue = issues[0];
  // A key the manifest doesn't know: name it where it is.
  if (issue?.code === "unrecognized_keys" && issue.keys?.length) {
    const named = issue.keys.map((key) =>
      [...issue.path.map(String), key].join("."),
    );
    return `The manifest's fields are not valid: ${named.join(", ")}: unknown key${named.length > 1 ? "s" : ""}`;
  }
  const at = issue?.path.map(String).join(".");
  return issue && at
    ? `The manifest's fields are not valid: ${at}: ${issue.message}`
    : "The manifest's fields are not valid";
}
