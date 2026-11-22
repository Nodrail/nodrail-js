// What attachments and consumers share while compiling: the resolved shapes,
// their projections, the agents and every binding made so far.
import type { ContractManifest } from "./grammar.ts";
import type { Projection } from "./project.ts";
import type { Path, Report } from "./resolve.ts";
import type {
  CompiledCondition,
  ConsumerId,
  ResolvedShape,
  Role,
  SurfaceId,
} from "./types.ts";

/**
 * A shape attached somewhere. Names are `<attachment>:<name>`: receipt:qa,
 * brief:qa, input:stripe.refund, output:stripe.refund, evidence:ci,
 * memory:notes, file:handoffs, request:refund, decision:refund, inventory.
 */
export type Binding = {
  surface: SurfaceId;
  name: string;
  /** Null only for a file contract with sections and no frontmatter. */
  shape: string | null;
  options: Record<string, unknown>;
};

/** A consumer's compiled reference: what it reads and the conditions it checks. */
export type ConsumerRef = {
  consumer: ConsumerId;
  /** Where it is declared, as a dotted path. */
  at: string;
  bindings: string[];
  conditions: CompiledCondition[];
  detail: Record<string, unknown>;
};

export type AgentContracts = {
  receipt: string | null;
  /** True when the receipt was picked because it has the agent's name. */
  implicit: boolean;
  brief: string | null;
};

export type Registry = {
  manifest: ContractManifest;
  /** Every shape name declared, resolved or not, so one mistake is reported once. */
  declared: Set<string>;
  shapes: Map<string, ResolvedShape>;
  projections: Map<string, Projection>;
  agents: Map<string, AgentContracts>;
  bindings: Map<string, Binding>;
  consumers: ConsumerRef[];
  report: Report;
};

/** Roles each attachment accepts, and the one it needs exactly once. */
const ROLE_RULES: Record<SurfaceId, { allowed: Role[]; once?: Role }> = {
  S01: { allowed: ["verdict", "findings", "usage"], once: "verdict" },
  S02: { allowed: [] },
  S03: { allowed: [] },
  S04: { allowed: [] },
  S05: { allowed: ["findings"] },
  S06: { allowed: ["kind"], once: "kind" },
  S07: { allowed: ["kind"] },
  S08: { allowed: [] },
  S09: { allowed: [] },
};

function checkRoles(
  shape: ResolvedShape,
  surface: SurfaceId,
  at: Path,
  report: Report,
) {
  const rules = ROLE_RULES[surface];
  const roles = Object.values(shape.properties).flatMap((p) =>
    p.role ? [p.role] : [],
  );
  let ok = true;
  for (const role of roles)
    if (!rules.allowed.includes(role)) {
      report(
        "role-unsupported",
        at,
        `role: ${role} isn't supported on this attachment (${surface})`,
      );
      ok = false;
    }
  if (rules.once && !roles.includes(rules.once)) {
    report(
      "role-required",
      at,
      `This attachment (${surface}) needs exactly one property with role: ${rules.once}`,
    );
    ok = false;
  }
  return ok;
}

/** Attaches a shape, checking it exists and suits the attachment; the shape, or null. */
export function bind(
  registry: Registry,
  binding: Binding,
  at: Path,
): ResolvedShape | null {
  if (binding.shape === null) {
    registry.bindings.set(binding.name, binding);
    return null;
  }
  const shape = registry.shapes.get(binding.shape);
  if (!shape) {
    // A declared shape that failed to resolve was reported already.
    if (!registry.declared.has(binding.shape))
      registry.report("unknown-shape", at, `No shape named ${binding.shape}`);
    return null;
  }
  if (!checkRoles(shape, binding.surface, at, registry.report)) return null;
  registry.bindings.set(binding.name, binding);
  return shape;
}

/** A bound shape and its projection, by binding name. */
export function bound(registry: Registry, name: string) {
  const binding = registry.bindings.get(name);
  if (!binding?.shape) return null;
  const shape = registry.shapes.get(binding.shape)!;
  const projection = registry.projections.get(binding.shape)!;
  return { binding, shape, projection };
}

export const dotted = (path: Path) => path.join(".");
