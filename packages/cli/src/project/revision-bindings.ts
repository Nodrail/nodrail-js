import { evidencePins } from "@nodrail/policy-engine/command-line";
import { compilePolicies } from "@nodrail/policy-engine/yaml";
import type { CompiledContracts, ResolvedShape } from "../contracts/engine.ts";
import { CliError } from "../io.ts";

const surfaces = {
  S01: "receipt",
  S02: "brief",
  S03: "tool_input",
  S04: "tool_result",
  S05: "evidence",
  S06: "memory_record",
  S07: "file",
  S09: "inventory_metadata",
} as const;

type Surface = (typeof surfaces)[keyof typeof surfaces];
type Revision = {
  surface: Surface;
  digest: string;
  name: string;
  dialect: 1;
  shape: ResolvedShape;
};
type Binding = { surface: Surface; target: string; contract_digest: string };

export function revisionBindings(
  contracts: CompiledContracts | null,
  yaml: string,
) {
  const compiled = compilePolicies([{ name: "effective.yaml", text: yaml }]);
  if (!compiled.ok)
    throw new CliError("The locked policy could not be compiled.");
  const { document } = compiled;
  const evidence = evidencePins(document);
  const revisions = new Map<string, Revision>();
  const bindings = new Map<string, Binding>();
  const pin = (target: string, revision: Revision) => {
    revisions.set(`${revision.surface}:${revision.digest}`, revision);
    bindings.set(target, {
      surface: revision.surface,
      target,
      contract_digest: revision.digest,
    });
  };
  for (const { name, surface, shape } of contracts?.bindings ?? []) {
    if (!shape || !contracts) continue;
    const { contract, shape: resolved } = contracts.shapes[shape]!;
    pin(name, {
      digest: contract,
      name: shape,
      surface: surfaces[surface],
      dialect: contracts.dialect,
      shape: resolved,
    });
  }
  if (document.version === 4) {
    for (const { name, contract, shape } of Object.values(document.evidence)) {
      if (!bindings.has(name))
        pin(name, {
          digest: contract,
          name: name.slice("evidence:".length),
          surface: "evidence",
          dialect: 1,
          shape,
        });
    }
  }
  return {
    ...(bindings.size
      ? {
          contracts: {
            revisions: [...revisions.values()],
            bindings: [...bindings.values()],
          },
        }
      : {}),
    ...(evidence ? { evidence } : {}),
  };
}
