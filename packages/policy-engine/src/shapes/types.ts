// The resolved form of a shape: what compile returns, what digests pin, and
// what the validator, projections and consumers read. No imports.

export const ROLES = ["verdict", "findings", "usage", "kind"] as const;
export type Role = (typeof ROLES)[number];

export const CLASSIFICATIONS = ["secret", "pii"] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

/** Every field is explicit, so the canonical form, and its digest, has one spelling. */
type Common = {
  optional: boolean;
  for: string | null;
  /** As declared: null when the property says nothing about reporting. */
  report: boolean | null;
  classification: Classification | null;
  role: Role | null;
};

export type ResolvedProperty = Common &
  (
    | { type: "string"; min: number; max: number }
    | { type: "enum"; values: string[] }
    | {
        type: "integer" | "number";
        min: number | null;
        max: number | null;
        unit: string | null;
      }
    | { type: "boolean" }
    | { type: "date"; min: string | null; max: string | null }
    | { type: "list"; min: number; max: number; of: ResolvedProperty }
    | { type: "object"; properties: Record<string, ResolvedProperty> }
  );

export type PropertyType = ResolvedProperty["type"];

export type ResolvedShape = {
  for: string | null;
  properties: Record<string, ResolvedProperty>;
};

/** Coverage IDs of the declared-contracts surfaces and consumers. */
export const SURFACES = [
  "S01",
  "S02",
  "S03",
  "S04",
  "S05",
  "S06",
  "S07",
  "S09",
] as const;
export type SurfaceId = (typeof SURFACES)[number];

export const CONSUMERS = [
  "C01",
  "C02",
  "C03",
  "C05",
  "C06",
  "C07",
  "C08",
  "C09",
  "C10",
] as const;
export type ConsumerId = (typeof CONSUMERS)[number];

/** A problem with declarations, at the declared path. Never echoes a value. */
export type ContractIssue = {
  code: string;
  path: (string | number)[];
  message: string;
};

/** One `where` condition, compiled against a resolved shape. */
export type CompiledCondition =
  | { path: string[]; op: "eq"; value: string | number | boolean }
  | {
      path: string[];
      op: "range";
      min: number | string | null;
      max: number | string | null;
    }
  | { path: string[]; op: "in"; values: (string | number)[] };
