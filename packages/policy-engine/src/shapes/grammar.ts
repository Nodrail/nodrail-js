// The declared-contracts grammar, dialect 1, as written in nodrail.yaml,
// Agent resources, rule files, module manifests, the lock and contract test
// cases. Every object is strict: a key this dialect does not know is an
// error, never ignored. docs/contracts.md is the prose version of this file.
import { z } from "zod";
import {
  ENUM_VALUE,
  LIMITS,
  PAYLOAD_BYTES,
  PROPERTY_NAME,
  SHAPE_NAME,
  UNIT,
  isDate,
} from "./limits.ts";
import { CLASSIFICATIONS, ROLES } from "./types.ts";

export const shapeName = z
  .string()
  .regex(SHAPE_NAME, "Lowercase letters, digits and -, starting with a letter");
export const propertyName = z
  .string()
  .regex(
    PROPERTY_NAME,
    "Lowercase letters, digits and _, starting with a letter",
  );
const enumValue = z
  .string()
  .regex(ENUM_VALUE, "Lowercase letters, digits, _, . and -");
const text = (max: number) => z.string().trim().min(1).max(max);
const dateText = z
  .string()
  .refine(isDate, "A quoted YYYY-MM-DD date that exists");
/** Finite numbers only, and a date as text: never a parsed Date. */
const bound = z.union([z.number().finite(), dateText]);

/** One property as written. Its type comes from `type`, `values`, `properties` or `of`. */
export type PropertyDecl = {
  type?:
    "string" | "integer" | "number" | "boolean" | "date" | "list" | "object";
  values?: string[];
  properties?: Record<string, PropertyDecl>;
  of?: PropertyDecl;
  min?: number | string;
  max?: number | string;
  unit?: string;
  optional?: boolean;
  for?: string;
  role?: (typeof ROLES)[number];
  report?: boolean;
  classification?: (typeof CLASSIFICATIONS)[number];
};

const propertiesOf = (item: z.ZodType<PropertyDecl>) =>
  z
    .record(propertyName, item)
    .refine((map) => Object.keys(map).length >= 1, "Declare a property")
    .refine(
      (map) => Object.keys(map).length <= LIMITS.properties,
      `At most ${LIMITS.properties} properties`,
    );

export const propertyDecl: z.ZodType<PropertyDecl> = z.lazy(() =>
  z.strictObject({
    type: z
      .enum([
        "string",
        "integer",
        "number",
        "boolean",
        "date",
        "list",
        "object",
      ])
      .optional(),
    values: z
      .array(enumValue)
      .min(1)
      .max(LIMITS.values)
      .refine(
        (items) => new Set(items).size === items.length,
        "Repeats a value",
      )
      .optional(),
    properties: propertiesOf(propertyDecl).optional(),
    of: propertyDecl.optional(),
    min: bound.optional(),
    max: bound.optional(),
    unit: z
      .string()
      .regex(UNIT, "A lowercase unit such as usd_cents")
      .optional(),
    optional: z.boolean().optional(),
    for: text(LIMITS.forText).optional(),
    role: z.enum(ROLES).optional(),
    report: z.boolean().optional(),
    classification: z.enum(CLASSIFICATIONS).optional(),
  }),
);

export const shapeDecl = z.strictObject({
  extends: shapeName.optional(),
  for: text(LIMITS.forText).optional(),
  properties: propertiesOf(propertyDecl),
});
export type ShapeDecl = z.infer<typeof shapeDecl>;

/** A dotted path through named properties: `findings.blocker`, `input.amount`. */
export const pathText = z
  .string()
  .regex(
    /^[a-z][a-z0-9_]{0,62}(?:\.[a-z][a-z0-9_]{0,62}){0,5}$/,
    "A dotted path of property names",
  );

const condition = z.union([
  z.string().max(LIMITS.stringMax),
  z.number().finite(),
  z.boolean(),
  z
    .strictObject({ min: bound.optional(), max: bound.optional() })
    .refine((range) => range.min !== undefined || range.max !== undefined, {
      message: "Give min, max or both",
    }),
  z.strictObject({
    in: z
      .array(z.union([z.string().max(LIMITS.stringMax), z.number().finite()]))
      .min(1)
      .max(LIMITS.values),
  }),
]);
export type ConditionDecl = z.infer<typeof condition>;

export const whereDecl = z
  .record(pathText, condition)
  .refine((map) => Object.keys(map).length >= 1, "Give a condition")
  .refine(
    (map) => Object.keys(map).length <= LIMITS.conditions,
    `At most ${LIMITS.conditions} conditions`,
  );
export type WhereDecl = z.infer<typeof whereDecl>;

export const agentRef = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "An agent name");
const toolName = z.string().regex(/^[a-z0-9_-]{1,64}$/, "A tool name");
export const headerKey = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{0,31}$/, "A header key");

// S01: receipts, in nodrail.yaml; Agent.spec.receipt picks one.
const receiptDecl = z
  .strictObject({
    shape: shapeName,
    format: z.enum(["fenced", "header"]).default("fenced"),
    header: z
      .strictObject({
        title: z
          .string()
          .regex(/^[A-Z][A-Z0-9 _-]{0,30}\{agent\}$/, "Such as RECEIPT {agent}")
          .default("RECEIPT {agent}"),
        aliases: z.record(headerKey, propertyName).optional(),
        mode_prefix: z.boolean().default(false),
      })
      .optional(),
  })
  .refine((receipt) => receipt.format === "header" || !receipt.header, {
    path: ["header"],
    message: "Only a format: header receipt has a header",
  });

/** Who produced a record; ordered by how much a gate may trust it. */
export const PRODUCER_CLASSES = [
  "agent-reported",
  "runtime-observed",
  "externally-verified",
  "person-authenticated",
] as const;
export type ProducerClass = (typeof PRODUCER_CLASSES)[number];
const gateAuthority = z.enum([
  "agent-reported",
  "runtime-observed",
  "externally-verified",
]);

// S05: evidence events from scripts, CI and integrations.
const producerDecl = z
  .strictObject({
    class: z.enum(["runtime-observed", "externally-verified"]),
    /** A verifier configured on the server; a provider name alone proves nothing. */
    verifier: shapeName.optional(),
  })
  .refine((p) => (p.class === "externally-verified") === Boolean(p.verifier), {
    message: "externally-verified names its verifier, and only it does",
  });
const evidenceDecl = z.strictObject({
  shape: shapeName,
  producers: z.array(producerDecl).min(1).max(10),
  subject: z.enum(["revision", "none"]).default("none"),
});

// S06: typed memory records behind a connection.
const memoryDecl = z.strictObject({
  shape: shapeName,
  connection: z.string().min(1).max(63),
  operations: z.strictObject({
    create: toolName,
    update: toolName.optional(),
    delete: toolName.optional(),
  }),
  /** Per value of the shape's kind: the agents that may create and update it. */
  writers: z.record(enumValue, z.array(agentRef).max(50)),
  deleters: z.array(agentRef).max(50).default([]),
  max_records: z.number().int().positive().max(100_000).optional(),
});

// S07: memory and artifacts as files.
const sectionName = z.string().trim().min(1).max(80);
const fileDecl = z
  .strictObject({
    root: z
      .string()
      .max(300)
      .regex(
        /^\.\/(?!(?:.*\/)?\.\.?(?:\/|$))(?!.*\/\/)[A-Za-z0-9_./-]+$/,
        "A project folder such as ./docs/adr, with no .. or wildcard",
      ),
    pattern: z
      .string()
      .max(200)
      .regex(
        /^(?:[A-Za-z0-9_.*-]+\/){0,3}[A-Za-z0-9_.*-]+\.md$/,
        "A .md file pattern; * matches within one folder",
      )
      .refine((p) => !p.includes("**"), "No ** : name each folder level"),
    frontmatter: shapeName.optional(),
    sections: z
      .array(
        z.union([
          sectionName,
          z.strictObject({ name: sectionName, optional: z.boolean() }),
        ]),
      )
      .max(LIMITS.sections)
      .default([]),
    max_bytes: z
      .number()
      .int()
      .positive()
      .max(PAYLOAD_BYTES.fileMax)
      .optional(),
    writers: z.array(agentRef).max(50).optional(),
  })
  .refine((file) => file.frontmatter || file.sections.length, {
    message: "Give frontmatter, sections or both",
  });

/** The control plane's roles a notification can go to. */
export const SERVER_ROLES = ["admin", "policy_manager"] as const;

// S09: inventory labels.
const inventoryDecl = z.strictObject({
  shape: shapeName,
  values: z.record(z.string(), z.unknown()),
});

/** What a view, insight or notification reads: one binding's projection. */
export const sourceDecl = z.union([
  z.strictObject({ receipt: shapeName }),
  z.strictObject({ evidence: shapeName }),
  z.strictObject({ memory: shapeName }),
]);
const paths = (min: number) => z.array(pathText).min(min).max(LIMITS.columns);
const viewDecl = z.strictObject({
  source: sourceDecl,
  columns: paths(1),
  filters: paths(0).default([]),
});
const insightDecl = z
  .strictObject({
    source: sourceDecl,
    measure: z.enum(["count", "validity", "verdicts", "rework", "sum"]),
    path: pathText.optional(),
    group: z.array(pathText).max(2).default([]),
  })
  .refine((i) => (i.measure === "sum") === Boolean(i.path), {
    path: ["path"],
    message: "sum, and only sum, takes a path",
  });
const notificationDecl = z.strictObject({
  source: sourceDecl,
  where: whereDecl.optional(),
  fields: paths(0).default([]),
  to: z.strictObject({ role: z.enum(SERVER_ROLES) }),
});

/** A connection operation's contract slots; the rest belongs to connections.ts. */
const operationDecl = z.strictObject({
  resource: z.unknown().optional(),
  input: shapeName.optional(),
  output: shapeName.optional(),
});
const connectionDecl = z
  .object({ operations: z.record(toolName, operationDecl.prefault({})) })
  .loose();

/** The contract keys of nodrail.yaml (and of a module manifest). */
export const contractFields = {
  shapes: z
    .record(shapeName, shapeDecl)
    .refine(
      (m) => Object.keys(m).length <= LIMITS.shapes,
      `At most ${LIMITS.shapes} shapes`,
    )
    .optional(),
  receipts: z.record(shapeName, receiptDecl).optional(),
  evidence: z.record(shapeName, evidenceDecl).optional(),
  memory: z.record(shapeName, memoryDecl).optional(),
  files: z.record(shapeName, fileDecl).optional(),
  inventory: inventoryDecl.optional(),
  views: z.record(shapeName, viewDecl).optional(),
  insights: z.record(shapeName, insightDecl).optional(),
  notifications: z.record(shapeName, notificationDecl).optional(),
};

/**
 * Keys of nodrail.yaml the setup schema owns (project-manifest.ts); this
 * grammar lets them through unread. Listed rather than imported, so browsers
 * can bundle the grammar; a test keeps the list equal to the setup's.
 */
export const SETUP_KEYS = [
  "kind",
  "imports",
  "id",
  "runtime",
  "runtimes",
  "team",
  "resources",
  "start",
  "agentConnections",
  "plugins",
  "agentPlugins",
  "telemetry",
  "tested",
  "observe",
  "connect",
] as const;
const setupKeys = Object.fromEntries(
  SETUP_KEYS.map((key) => [key, z.unknown().optional()]),
);

export const contractManifest = z.strictObject({
  ...setupKeys,
  ...contractFields,
  connections: z.record(z.string(), connectionDecl).optional(),
});
export type ContractManifest = z.infer<typeof contractManifest>;

// C01: what a gate requires, by receipt or by evidence.
export const receiptRequirement = z.strictObject({
  agent: z.string().min(1).max(63),
  verdict: z.union([z.string(), z.array(z.string()).min(1).max(20)]),
  since: z.unknown().optional(),
  where: whereDecl.optional(),
  authority: gateAuthority.optional(),
  subject: z.literal("revision").optional(),
});
export const evidenceRequirement = z.strictObject({
  evidence: shapeName,
  where: whereDecl.optional(),
  authority: gateAuthority,
  subject: z.literal("revision").optional(),
});

/** A rule-file item's contract fields; the rest belongs to rules-file.ts. */
export const policyItem = z
  .object({
    rule: z.string().optional(),
    gate: z.string().optional(),
    budget: z.string().optional(),
    required_engine_version: z.number().int().optional(),
    tool: z.string().optional(),
    operation: z.string().optional(),
    resource: z.unknown().optional(),
    effect: z.string().optional(),
    otherwise: z.string().optional(),
    where: whereDecl.optional(),
    requires: z.array(z.unknown()).optional(),
    sum: z
      .strictObject({ tool: z.string(), operation: z.string(), path: pathText })
      .optional(),
    unit: z.string().regex(UNIT).optional(),
  })
  .loose();
export type PolicyItem = z.infer<typeof policyItem>;

// C08: a module's contracts, pinned to an exact version.
export const moduleDecl = z.strictObject({
  ref: z
    .string()
    .regex(/^@[a-z0-9-]+\/[a-z0-9-]+@[0-9A-Za-z.+-]+$/, "@scope/name@version"),
  shapes: contractFields.shapes,
  receipts: contractFields.receipts,
});

// C07: the lock's contracts section.
const digestText = z.string().regex(/^sha256:[0-9a-f]{64}$/);
export const lockDecl = z.strictObject({
  dialect: z.literal(1),
  digest: digestText,
  shapes: z.record(
    shapeName,
    z.strictObject({ contract: digestText, projection: digestText }),
  ),
});
export type LockDecl = z.infer<typeof lockDecl>;

// C06: side-effect-free contract test cases.
export const caseDecl = z.strictObject({
  name: text(120),
  /** A binding, such as receipt:reviewer, input:stripe.refund or shape:x. */
  target: z.string().regex(/^[a-z]+(?::[a-z0-9_.-]{1,130})?$/),
  value: z.unknown(),
  expect: z.enum(["valid", "invalid"]),
  /** For invalid: each issue as `path: code`. */
  issues: z.array(z.string().max(200)).max(20).optional(),
  /** For valid: the reporting projection it must produce. */
  projection: z.unknown().optional(),
});
export type CaseDecl = z.infer<typeof caseDecl>;
