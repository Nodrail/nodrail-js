// Consumer references in rule files: gates (C01), permission rules (C02),
// budgets (C03) and approval links (C04). Each is checked against the shapes
// it reads. Views, insights and notifications are in outputs.ts.
import type { z } from "zod";
import {
  evidenceRequirement,
  policyItem,
  receiptRequirement,
  type PolicyItem,
  type WhereDecl,
} from "./grammar.ts";
import { satisfiesAuthority } from "./authority.ts";
import { ACCOUNTABLE_ENGINE_LEVEL, CONTRACTS_ENGINE_LEVEL } from "./limits.ts";
import { bound, dotted, type Registry } from "./registry.ts";
import type { Path } from "./resolve.ts";
import type { ResolvedShape } from "./types.ts";
import { compileWhere, propertyAt, single, type Scope } from "./where.ts";

const grammarIssues = (
  registry: Registry,
  at: Path,
  issues: z.core.$ZodIssue[],
) => {
  for (const issue of issues)
    registry.report(
      "grammar",
      [...at, ...(issue.path as (string | number)[])],
      issue.message,
    );
};

/** Roots a rule's `where` reads: the operation's input and result, a started agent's brief. */
function ruleScope(registry: Registry, item: PolicyItem): Scope {
  const roots: Scope["roots"] = {};
  const id = `${item.tool}.${item.operation}`;
  for (const [root, slot] of [
    ["input", "input"],
    ["result", "output"],
  ] as const) {
    const found = bound(registry, `${slot}:${id}`);
    if (found) roots[root] = { shape: found.shape };
  }
  const resource = item.resource as
    { kind?: unknown; match?: unknown; value?: unknown } | undefined;
  if (
    resource?.kind === "agent" &&
    resource.match === "exact" &&
    typeof resource.value === "string"
  ) {
    const found = bound(registry, `brief:${resource.value}`);
    if (found) roots.brief = { shape: found.shape };
  }
  return { roots, prefixed: true };
}

const usesContracts = (item: PolicyItem) =>
  Boolean(item.where || item.approval || item.sum || item.unit) ||
  (item.requires ?? []).some(
    (r) =>
      typeof r === "object" &&
      r !== null &&
      ["where", "authority", "subject", "evidence"].some((key) => key in r),
  );

/** Evidence requirements and numeric budgets (C03) are engine level 5. */
const usesAccountable = (item: PolicyItem) =>
  Boolean(item.sum || item.unit) ||
  (item.requires ?? []).some(
    (r) => typeof r === "object" && r !== null && "evidence" in r,
  );

/** Whether a path goes through or ends at a secret property. */
function secretPath(shape: ResolvedShape, path: string) {
  let properties = shape.properties;
  for (const key of path.split(".")) {
    const property = Object.hasOwn(properties, key)
      ? properties[key]
      : undefined;
    if (!property) return false;
    if (property.classification === "secret") return true;
    if (property.type !== "object") return false;
    properties = property.properties;
  }
  return false;
}

/** Verdict words a gate waits for must be ones the receipt can say. */
function checkVerdicts(
  registry: Registry,
  shape: ResolvedShape,
  words: string[],
  at: Path,
) {
  const verdict = Object.values(shape.properties).find(
    (p) => p.role === "verdict",
  );
  for (const word of words)
    if (verdict?.type === "enum" && !verdict.values.includes(word))
      registry.report(
        "verdict-value",
        at,
        `${word} isn't a verdict this receipt can give`,
      );
}

// C01: a requirement on a receipt.
function receiptNeed(registry: Registry, raw: unknown, at: Path) {
  const parsed = receiptRequirement.safeParse(raw);
  if (!parsed.success) return grammarIssues(registry, at, parsed.error.issues);
  const need = parsed.data;
  const receipt = registry.agents.get(need.agent)?.receipt;
  const found = receipt ? bound(registry, `receipt:${receipt}`) : null;
  if (need.authority && need.authority !== "agent-reported")
    registry.report(
      "authority",
      [...at, "authority"],
      "A receipt is agent-reported; require evidence for more",
    );
  if (!found) {
    if (need.where)
      registry.report(
        "unknown-reference",
        [...at, "agent"],
        `${need.agent} has no declared receipt to read where from`,
      );
    return;
  }
  const words = Array.isArray(need.verdict) ? need.verdict : [need.verdict];
  checkVerdicts(registry, found.shape, words, [...at, "verdict"]);
  gateNeed(
    registry,
    found,
    { where: need.where, at },
    {
      authority: "agent-reported",
      subject: need.subject ?? null,
      verdicts: words,
    },
  );
}

/** A gate requirement's `where`, compiled against what it reads, as a C01 reference. */
function gateNeed(
  registry: Registry,
  found: { shape: ResolvedShape; binding: { name: string } },
  { where, at }: { where?: WhereDecl; at: Path },
  detail: Record<string, unknown>,
) {
  const conditions = where
    ? compileWhere(
        where,
        single(found.shape),
        [...at, "where"],
        registry.report,
      )
    : [];
  registry.consumers.push({
    consumer: "C01",
    at: dotted(at),
    bindings: [found.binding.name],
    conditions: conditions ?? [],
    detail,
  });
}

// C01: a requirement on evidence.
function evidenceNeed(registry: Registry, raw: unknown, at: Path) {
  const parsed = evidenceRequirement.safeParse(raw);
  if (!parsed.success) return grammarIssues(registry, at, parsed.error.issues);
  const need = parsed.data;
  const found = bound(registry, `evidence:${need.evidence}`);
  if (!found) {
    registry.report(
      "unknown-reference",
      [...at, "evidence"],
      `No evidence named ${need.evidence}`,
    );
    return;
  }
  const declared = registry.manifest.evidence![need.evidence]!;
  if (
    !declared.producers.some((p) => satisfiesAuthority(p.class, need.authority))
  )
    registry.report(
      "authority",
      [...at, "authority"],
      `No producer of ${need.evidence} is ${need.authority}`,
    );
  if (need.subject === "revision" && declared.subject !== "revision")
    registry.report(
      "subject",
      [...at, "subject"],
      `${need.evidence} isn't bound to a revision; declare subject: revision on it`,
    );
  // v1: an old result never opens a gate for new work.
  if (need.subject !== "revision")
    registry.report(
      "subject",
      [...at, "subject"],
      "An evidence requirement says subject: revision, so only evidence about the current work counts",
    );
  // Cloud keeps no secret path of evidence, so a condition on one could never be evaluated there.
  for (const path of Object.keys(need.where ?? {}))
    if (secretPath(found.shape, path))
      registry.report(
        "path",
        [...at, "where", path],
        `${path} is secret; an evidence condition can't read a secret path`,
      );
  gateNeed(
    registry,
    found,
    { where: need.where, at },
    {
      authority: need.authority,
      subject: need.subject ?? null,
    },
  );
}

// C03: a budget summing one typed numeric argument or result.
function numericBudget(registry: Registry, item: PolicyItem, at: Path) {
  if (!item.sum) {
    registry.report("unit", [...at, "unit"], "unit goes with sum");
    return;
  }
  const { tool, operation, path } = item.sum;
  const found = propertyAt(
    ruleScope(registry, { tool, operation }),
    path,
    [...at, "sum", "path"],
    registry.report,
  );
  if (!found) return;
  const { property } = found;
  if (property.type !== "integer")
    return registry.report(
      "path-type",
      [...at, "sum", "path"],
      "A budget sums whole minor units: an integer property",
    );
  if (!property.unit || property.unit !== item.unit)
    return registry.report(
      "unit",
      [...at, "unit"],
      `The budget's unit must equal the property's (${property.unit ?? "none declared"})`,
    );
  // An argument is known before the call and can be reserved; a result is only measured after it.
  const mode = path.startsWith("input.") ? "admission" : "measured";
  registry.consumers.push({
    consumer: "C03",
    at: dotted(at),
    bindings: [
      `${path.startsWith("input.") ? "input" : "output"}:${tool}.${operation}`,
    ],
    conditions: [],
    detail: { path, unit: item.unit, mode },
  });
}

function policyEntry(registry: Registry, item: PolicyItem, at: Path) {
  if (item.where) {
    const scope = ruleScope(registry, item);
    const conditions = compileWhere(
      item.where,
      scope,
      [...at, "where"],
      registry.report,
    );
    registry.consumers.push({
      consumer: "C02",
      at: dotted(at),
      bindings: [],
      conditions: conditions ?? [],
      detail: { tool: item.tool ?? null, operation: item.operation ?? null },
    });
  }
  if (item.approval !== undefined) {
    if (!registry.manifest.approvals?.[item.approval])
      registry.report(
        "unknown-reference",
        [...at, "approval"],
        `No approval form named ${item.approval}`,
      );
    if ((item.effect ?? item.otherwise) !== "require_approval")
      registry.report(
        "approval-effect",
        [...at, "approval"],
        "Only a require_approval rule or gate has an approval form",
      );
  }
  if (item.gate !== undefined)
    (item.requires ?? []).forEach((raw, index) => {
      const here = [...at, "requires", index];
      if (typeof raw === "object" && raw !== null && "evidence" in raw)
        evidenceNeed(registry, raw, here);
      else receiptNeed(registry, raw, here);
    });
  if (item.budget !== undefined && (item.sum || item.unit))
    numericBudget(registry, item, at);
}

/** One rule file's items, in order. */
export function compilePolicy(registry: Registry, items: unknown[], at: Path) {
  const parsed = items.map((raw, index) => {
    const result = policyItem.safeParse(raw);
    if (!result.success)
      grammarIssues(registry, [...at, index], result.error.issues);
    return result.success ? result.data : null;
  });
  const level = Math.max(
    0,
    ...parsed.map((item) => item?.required_engine_version ?? 0),
  );
  parsed.forEach((item, index) => {
    if (!item) return;
    if (usesContracts(item) && level < CONTRACTS_ENGINE_LEVEL)
      registry.report(
        "engine-level",
        [...at, index],
        `Contract fields need required_engine_version: ${CONTRACTS_ENGINE_LEVEL} in this file, so older engines refuse it`,
      );
    else if (usesAccountable(item) && level < ACCOUNTABLE_ENGINE_LEVEL)
      registry.report(
        "engine-level",
        [...at, index],
        `Evidence requirements and numeric budgets need required_engine_version: ${ACCOUNTABLE_ENGINE_LEVEL} in this file, so older engines refuse it`,
      );
    policyEntry(registry, item, [...at, index]);
  });
}
