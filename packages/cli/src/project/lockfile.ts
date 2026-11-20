import { createHash } from "node:crypto";
import {
  ENGINE_VERSION,
  type Catalog,
  type ProjectResolution,
} from "@nodrail/policy-engine/yaml";
import { Document, isScalar, parse, Scalar, visit } from "yaml";
import { z } from "zod";
import { workspaceDigest, type Hashed } from "./workspace.ts";

export const MANIFEST_FILE = "nodrail.yaml";
export const LOCK_FILE = "nodrail.lock.yaml";
/** A policy-only project's lock. */
const LOCK_SCHEMA = 1;
/** A setup's lock: the policy, and the whole workspace the hosts get. */
const LOCK_WORKSPACE = 2;

/** Text is hashed as UTF-8; bytes as they are. */
export const sha256 = (data: string | Uint8Array) =>
  createHash("sha256").update(data).digest("hex");

const hashed = z.object({ path: z.string(), sha256: z.string() }).strict();

const lockShape = z
  .object({
    lock: z.union([z.literal(LOCK_SCHEMA), z.literal(LOCK_WORKSPACE)]),
    engine: z.number().int(),
    manifest: hashed,
    modules: z.array(
      z
        .object({
          id: z.string(),
          version: z.string(),
          with: z.record(z.string(), z.string()),
          missing: z.array(z.string()),
          files: z.array(hashed),
        })
        .strict(),
    ),
    files: z.array(hashed),
    edges: z.array(z.object({ from: z.string(), to: z.string() }).strict()),
    order: z.array(z.string()),
    effective: z.object({ sha256: z.string() }).strict().nullable(),
    /**
     * The reviewed workspace: one digest over every file above, the
     * catalog's included, and the instructions and skill files listed here.
     */
    workspace: z
      .object({ sha256: z.string(), files: z.array(hashed) })
      .strict()
      .optional(),
    /** The effective policy last reviewed, to show what the next change does. */
    baseline: z.string(),
  })
  .strict()
  .refine(
    (lock) => (lock.lock === LOCK_WORKSPACE) === (lock.workspace !== undefined),
  );

export type Lock = z.infer<typeof lockShape>;

const HEADER = `# Written by \`nodrail add\` and \`nodrail policy lock\`. Commit it with
# nodrail.yaml. \`nodrail policy export --frozen\` checks every file below
# against it and refuses to export anything that differs.
`;

/** The lock for a resolved project. Same inputs, same bytes, on any machine. */
export function lockFor(input: {
  resolution: ProjectResolution;
  manifest: { path: string; text: string };
  catalog: Catalog;
  effective: string | null;
  previous: Lock | null;
  /** A setup's instructions and skill files; null for a policy alone. */
  content: Hashed[] | null;
}): Lock {
  const { resolution, manifest, catalog, effective, content } = input;
  const lock: Lock = {
    lock: content === null ? LOCK_SCHEMA : LOCK_WORKSPACE,
    engine: ENGINE_VERSION,
    manifest: { path: manifest.path, sha256: sha256(manifest.text) },
    modules: resolution.modules
      .map((use) => {
        const module = catalog.find(
          (entry) => entry.id === use.id && entry.version === use.version,
        );
        return {
          id: use.id,
          version: use.version,
          with: use.bindings,
          missing: use.missing,
          files: Object.entries(module?.files ?? {})
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([path, text]) => ({ path, sha256: sha256(text) })),
        };
      })
      .sort((a, b) => (a.id < b.id ? -1 : 1)),
    files: resolution.inputs.flatMap((file) =>
      file.kind === "local" && file.path !== manifest.path
        ? [{ path: file.path, sha256: sha256(file.text) }]
        : [],
    ),
    edges: resolution.edges,
    order: resolution.sources.map((source) => source.name),
    effective: effective === null ? null : { sha256: sha256(effective) },
    baseline: effective ?? input.previous?.baseline ?? "",
  };
  if (content === null) return lock;
  // The workspace section goes before the baseline, which is long.
  const { baseline, ...rest } = lock;
  return {
    ...rest,
    workspace: {
      sha256: workspaceDigest(sourcesOf(lock, content), sha256),
      files: content,
    },
    baseline,
  };
}

/**
 * What the workspace digest covers: every file the lock records, each by its
 * path, catalog files by module, and the effective policy compiled from them,
 * so another engine's policy is another revision.
 */
export function sourcesOf(lock: Lock, content: Hashed[]): Hashed[] {
  return [
    ...(lock.effective
      ? [{ path: "<effective policy>", sha256: lock.effective.sha256 }]
      : []),
    lock.manifest,
    ...lock.files,
    ...lock.modules.flatMap((module) =>
      module.files.map((file) => ({
        path: `${module.id}@${module.version}/${file.path}`,
        sha256: file.sha256,
      })),
    ),
    ...content,
  ];
}

/**
 * The lock as text. Hashes are quoted: one that happens to be all digits
 * would otherwise read back as a number.
 */
export function lockText(lock: Lock) {
  const document = new Document(lock);
  visit(document, {
    Pair(_key, pair) {
      if (
        isScalar(pair.key) &&
        pair.key.value === "sha256" &&
        isScalar(pair.value)
      )
        pair.value.type = Scalar.QUOTE_DOUBLE;
    },
  });
  return HEADER + document.toString({ lineWidth: 0, blockQuote: "literal" });
}

/** The lock, or a reason it can't be read. */
export function readLock(text: string): Lock | string {
  let value: unknown;
  try {
    value = parse(text);
  } catch {
    return "nodrail.lock.yaml is not YAML";
  }
  if (
    value !== null &&
    typeof value === "object" &&
    "lock" in value &&
    value.lock !== LOCK_SCHEMA &&
    value.lock !== LOCK_WORKSPACE
  )
    return `nodrail.lock.yaml uses lock format ${String(value.lock)}; this nodrail reads ${LOCK_SCHEMA} and ${LOCK_WORKSPACE}. Update nodrail.`;
  const lock = lockShape.safeParse(value);
  return lock.success ? lock.data : "nodrail.lock.yaml is damaged";
}

export const pinsOf = (lock: Lock | null) =>
  Object.fromEntries((lock?.modules ?? []).map((m) => [m.id, m.version]));
