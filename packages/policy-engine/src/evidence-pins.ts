import type { PolicyDocument } from "./policies.ts";

/** The evidence bindings and addresses a connected hook will query. */
export function evidencePins(document: PolicyDocument) {
  if (document.version !== 4) return undefined;
  const bindings = Object.entries(document.evidence).map(
    ([evidence, contract]) => ({
      evidence,
      contract_digest: contract.contract,
      verifiers: [
        ...new Set(
          contract.producers.flatMap(({ verifier }) =>
            verifier ? [verifier] : [],
          ),
        ),
      ].sort(),
      subject: contract.subject,
    }),
  );
  const requirements = document.gates.flatMap((gate) =>
    (gate.evidence ?? []).map(
      ({ evidence, authority, subject, where }, index) => ({
        gate: gate.id,
        index,
        evidence,
        authority,
        subject,
        where,
      }),
    ),
  );
  return bindings.length || requirements.length
    ? { bindings, requirements }
    : undefined;
}
