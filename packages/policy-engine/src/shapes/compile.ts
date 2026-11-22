// Compiling declared contracts (dialect 1): parse
// the grammar, merge module contracts, resolve shapes, attach them, check
// every consumer, digest the closure, then check the lock and test cases.
import canonicalize from "canonicalize";
import { bindAll } from "./attachments.ts";
import { compilePolicy } from "./consumers.ts";
import { compileOutputs } from "./outputs.ts";
import { contractDigest } from "./digest.ts";
import {
  caseDecl,
  contractManifest,
  lockDecl,
  moduleDecl,
  type ContractManifest,
  type ShapeDecl,
} from "./grammar.ts";
import { CONTRACT_DIALECT, LIMITS } from "./limits.ts";
import { projectShape, projectValue, type Projection } from "./project.ts";
import type {
  AgentContracts,
  Binding,
  ConsumerRef,
  Registry,
} from "./registry.ts";
import { collector, resolveShapes, type Path, type Report } from "./resolve.ts";
import type {
  ConsumerId,
  ContractIssue,
  ResolvedShape,
  SurfaceId,
} from "./types.ts";
import { validateValue, type ValueIssue } from "./validate.ts";

/** Everything a workspace declares about contracts, as read from its files. */
export type ContractSources = {
  /** nodrail.yaml. */
  manifest?: unknown;
  /** Resource documents; Agents carry `spec.receipt` and `spec.brief`. */
  resources?: unknown[];
  /** One rule file's items. */
  policy?: unknown[];
  /** Imported modules' contracts (C08). */
  modules?: unknown[];
  /** The lock's contracts section (C07). */
  lock?: unknown;
  /** Contract test cases (C06). */
  cases?: unknown[];
};

export type CompiledShape = {
  shape: ResolvedShape;
  /** The full contract's digest. */
  contract: string;
  projection: Projection;
};

export type CompiledContracts = {
  dialect: typeof CONTRACT_DIALECT;
  /** The closure: every shape, binding and consumer reference. */
  digest: string;
  shapes: Record<string, CompiledShape>;
  bindings: (Binding & { digest: string })[];
  agents: Record<string, AgentContracts>;
  consumers: ConsumerRef[];
  /** What a runtime must support before apply can call any of this enforced. */
  surfaces: SurfaceId[];
  consumerIds: ConsumerId[];
};

export type CaseResult = {
  name: string;
  passed: boolean;
  issues: ValueIssue[];
};

export type ContractsResult = {
  ok: boolean;
  issues: ContractIssue[];
  contracts: CompiledContracts | null;
  cases: CaseResult[];
};

const M = "nodrail.yaml";

const zodIssues = (
  report: Report,
  at: Path,
  issues: { path: PropertyKey[]; message: string }[],
) => {
  for (const issue of issues)
    report(
      "grammar",
      [...at, ...(issue.path as (string | number)[])],
      issue.message,
    );
};

type Owned<T> = Map<string, { decl: T; from: string }>;

/** Module contracts join the project's; the same name with another definition is an error. */
function mergeModules(
  manifest: ContractManifest,
  modules: unknown[],
  report: Report,
) {
  const shapes: Owned<ShapeDecl> = new Map(
    Object.entries(manifest.shapes ?? {}).map(([n, d]) => [
      n,
      { decl: d, from: "the project" },
    ]),
  );
  const receipts: Owned<NonNullable<ContractManifest["receipts"]>[string]> =
    new Map(
      Object.entries(manifest.receipts ?? {}).map(([n, d]) => [
        n,
        { decl: d, from: "the project" },
      ]),
    );
  modules.forEach((raw, index) => {
    const parsed = moduleDecl.safeParse(raw);
    if (!parsed.success)
      return zodIssues(report, ["modules", index], parsed.error.issues);
    const { ref } = parsed.data;
    for (const [field, owned] of [
      ["shapes", shapes],
      ["receipts", receipts],
    ] as const)
      for (const [name, decl] of Object.entries(parsed.data[field] ?? {})) {
        const earlier = owned.get(name);
        if (!earlier) owned.set(name, { decl: decl as never, from: ref });
        else if (canonicalize(earlier.decl) !== canonicalize(decl))
          report(
            "collision",
            ["modules", index, field, name],
            `${name} is also defined, differently, by ${earlier.from}`,
          );
      }
  });
  const unwrap = <T>(owned: Owned<T>) =>
    Object.fromEntries([...owned].map(([n, { decl }]) => [n, decl]));
  if (shapes.size > LIMITS.shapes)
    report(
      "grammar",
      [M, "shapes"],
      `At most ${LIMITS.shapes} shapes, imports included`,
    );
  return { ...manifest, shapes: unwrap(shapes), receipts: unwrap(receipts) };
}

function bindingDigests(
  registry: Registry,
  shapes: Record<string, CompiledShape>,
) {
  return [...registry.bindings.values()]
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .map((binding) => {
      const shape = binding.shape === null ? null : shapes[binding.shape]!;
      const digest = contractDigest("binding", {
        name: binding.name,
        options: binding.options,
        projection: shape?.projection.digest ?? null,
        shape: shape?.contract ?? null,
        surface: binding.surface,
      });
      return { ...binding, digest };
    });
}

function closure(registry: Registry): CompiledContracts {
  const shapes = Object.fromEntries(
    [...registry.shapes].map(([name, shape]) => [
      name,
      {
        shape,
        contract: contractDigest("shape", shape),
        projection: registry.projections.get(name)!,
      },
    ]),
  );
  const bindings = bindingDigests(registry, shapes);
  const agents = Object.fromEntries(
    [...registry.agents].sort(([a], [b]) => (a < b ? -1 : 1)),
  );
  const consumers = [...registry.consumers].sort((a, b) =>
    a.at < b.at ? -1 : 1,
  );
  const digest = contractDigest("workspace", {
    agents,
    bindings: bindings.map(({ name, digest: d }) => ({ digest: d, name })),
    consumers,
    dialect: CONTRACT_DIALECT,
    shapes: Object.fromEntries(
      Object.entries(shapes).map(([n, s]) => [
        n,
        { contract: s.contract, projection: s.projection.digest },
      ]),
    ),
  });
  const unique = <T extends string>(items: T[]) => [...new Set(items)].sort();
  return {
    dialect: CONTRACT_DIALECT,
    digest,
    shapes,
    bindings,
    agents,
    consumers,
    surfaces: unique(bindings.map((b) => b.surface)),
    consumerIds: unique(consumers.map((c) => c.consumer)),
  };
}

/** The lock's contracts section for a compiled workspace (C07). */
export function lockSection(contracts: CompiledContracts) {
  return {
    dialect: contracts.dialect,
    digest: contracts.digest,
    shapes: Object.fromEntries(
      Object.entries(contracts.shapes).map(([name, s]) => [
        name,
        { contract: s.contract, projection: s.projection.digest },
      ]),
    ),
  };
}

function checkLock(raw: unknown, contracts: CompiledContracts, report: Report) {
  const parsed = lockDecl.safeParse(raw);
  if (!parsed.success) return zodIssues(report, ["lock"], parsed.error.issues);
  const expected = lockSection(contracts);
  if (parsed.data.digest !== expected.digest)
    report(
      "lock-mismatch",
      ["lock", "digest"],
      "The contracts changed since the lock was written; review the diff and lock again",
    );
  const names = new Set([
    ...Object.keys(expected.shapes),
    ...Object.keys(parsed.data.shapes),
  ]);
  for (const name of names)
    if (
      canonicalize(parsed.data.shapes[name]) !==
      canonicalize(expected.shapes[name])
    )
      report(
        "lock-mismatch",
        ["lock", "shapes", name],
        `${name} differs from the locked contract`,
      );
}

/** The shape a case's target names: a binding, or shape:<name>. */
function caseShape(registry: Registry, target: string) {
  if (target.startsWith("shape:"))
    return registry.shapes.get(target.slice(6)) ?? null;
  const shape = registry.bindings.get(target)?.shape;
  return shape ? (registry.shapes.get(shape) ?? null) : null;
}

function caseProblem(
  projection: Projection,
  decl: ReturnType<typeof caseDecl.parse>,
  issues: ValueIssue[],
) {
  const said = issues.map((issue) => `${issue.path}: ${issue.code}`);
  if (decl.expect === "invalid") {
    if (!issues.length) return "expected invalid, but the value conforms";
    const missing = (decl.issues ?? []).filter(
      (issue) => !said.includes(issue),
    );
    return missing.length
      ? `expected ${missing.join("; ")}, got ${said.join("; ")}`
      : null;
  }
  if (issues.length) return `expected valid, got ${said.join("; ")}`;
  const projected = projectValue(
    projection,
    decl.value as Record<string, unknown>,
  );
  if (validateValue(projection.shape, projected).length)
    return "its projection doesn't validate";
  if (
    decl.projection !== undefined &&
    canonicalize(projected) !== canonicalize(decl.projection)
  )
    return `projection is ${canonicalize(projected)}`;
  return null;
}

function runCases(
  registry: Registry,
  cases: unknown[],
  report: Report,
): CaseResult[] {
  if (cases.length > LIMITS.cases)
    report("grammar", ["cases"], `At most ${LIMITS.cases} cases`);
  return cases.slice(0, LIMITS.cases).flatMap((raw, index) => {
    const parsed = caseDecl.safeParse(raw);
    if (!parsed.success) {
      zodIssues(report, ["cases", index], parsed.error.issues);
      return [];
    }
    const shape = caseShape(registry, parsed.data.target);
    if (!shape) {
      report(
        "unknown-reference",
        ["cases", index, "target"],
        `No binding or shape ${parsed.data.target}`,
      );
      return [];
    }
    const issues = validateValue(shape, parsed.data.value);
    const projection = projectShape(shape);
    const problem = caseProblem(projection, parsed.data, issues);
    if (problem)
      report(
        "case-failed",
        ["cases", index],
        `${parsed.data.name}: ${problem}`,
      );
    return [{ name: parsed.data.name, passed: problem === null, issues }];
  });
}

/** Compiles a workspace's contracts. Issues are errors: nothing here is a warning. */
export function compileContracts(sources: ContractSources): ContractsResult {
  const { issues, report } = collector();
  const parsed = contractManifest.safeParse(sources.manifest ?? {});
  if (!parsed.success) {
    zodIssues(report, [M], parsed.error.issues);
    return { ok: false, issues, contracts: null, cases: [] };
  }
  const manifest = mergeModules(parsed.data, sources.modules ?? [], report);
  const shapes = resolveShapes(manifest.shapes, (code, path, message) =>
    report(code, [M, ...path], message),
  );
  // An invalid shape is left out, so everything that reads it would fail
  // too, each at its own line: say only what is wrong with the shapes.
  if (issues.length > 0)
    return { ok: false, issues, contracts: null, cases: [] };
  const registry: Registry = {
    manifest,
    declared: new Set(Object.keys(manifest.shapes)),
    shapes,
    projections: new Map(
      [...shapes].map(([name, shape]) => [name, projectShape(shape)]),
    ),
    agents: new Map(),
    bindings: new Map(),
    consumers: [],
    report,
  };
  bindAll(registry, sources.resources ?? []);
  compilePolicy(registry, sources.policy ?? [], ["policy"]);
  compileOutputs(registry);
  const contracts = closure(registry);
  if (sources.lock !== undefined) checkLock(sources.lock, contracts, report);
  const cases = runCases(registry, sources.cases ?? [], report);
  return {
    ok: issues.length === 0,
    issues,
    contracts: issues.length ? null : contracts,
    cases,
  };
}
