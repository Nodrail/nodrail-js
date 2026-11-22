// Which kind of policy document is which, for code that reads any version.
import type { EvidenceNeed, NumericBudget } from "./accountable-document.ts";
import type { PolicyDocument, PolicyGate } from "./policies.ts";

/** A document that carries declared contracts: version 3 or 4. */
export type ContractsDocument = Extract<PolicyDocument, { version: 3 | 4 }>;
export const hasContracts = (
  document: PolicyDocument,
): document is ContractsDocument => document.version >= 3;
/** The numeric budgets of a document; only version 4 has any. */
export const limitsOf = (document: PolicyDocument): NumericBudget[] =>
  document.version === 4 ? document.limits : [];
/** A gate's evidence requirements; only version 4 has any. */
export const evidenceOf = (gate: PolicyGate): EvidenceNeed[] =>
  "evidence" in gate && gate.evidence ? gate.evidence : [];

/** What the compiler adds to a command gate's id for `<prefix> <args…>`. */
const WITH_ARGUMENTS = "-args";

/**
 * The id a person declared for a gate. A gate on a command prefix compiles
 * to two: the command alone, under the declared id, and the command with
 * arguments, under `<id>-args`, which is the compiler's, never the person's.
 */
export function declaredGateId(gate: PolicyGate) {
  const { resource, toolKey, id, name } = gate;
  return toolKey === "shell" &&
    resource.kind === "command" &&
    resource.match === "prefix" &&
    id.endsWith(WITH_ARGUMENTS) &&
    name.endsWith(" with arguments")
    ? id.slice(0, -WITH_ARGUMENTS.length)
    : id;
}

/** Each gate once, as declared: a command gate's `-args` twin is left out. */
export function declaredGates<T extends PolicyGate>(gates: readonly T[]) {
  const seen = new Set<string>();
  return gates.filter((gate) => {
    const id = declaredGateId(gate);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}
