// Engine version 4: a rule file's `contracts` entry and what reads it — gate
// requirements on receipts (C01), and rules and gates with `where` on a
// call's declared input or a started agent's brief (C02) — compiled by the
// one contracts compiler (shapes/compile.ts) so a rule file and nodrail.yaml
// can never disagree about a contract. Every problem is reported at its own
// file and line.
import type { Compiling } from "./compile-runs.ts";
import type {
  ContractRequirement,
  EvidenceContract,
  EvidenceNeed,
} from "./policies.ts";
import { agentName } from "./names.ts";
import { pick, type Path } from "./positions.ts";
import type { Located, RuleFields } from "./rules-file.ts";
import type {
  BudgetFields,
  GateFields,
  RequirementEntry,
} from "./run-entries.ts";
import {
  briefContracts,
  inputContracts,
  type BriefContract,
} from "./shapes/brief.ts";
import { compileContracts } from "./shapes/compile.ts";
import type { InputContract } from "./shapes/inputs.ts";
import {
  ACCOUNTABLE_ENGINE_LEVEL,
  CONTRACTS_ENGINE_LEVEL,
} from "./shapes/limits.ts";
import type { CompiledContracts } from "./shapes/compile.ts";
import { receiptContracts, type ReceiptContract } from "./shapes/receipt.ts";
import type { CompiledCondition } from "./shapes/types.ts";

type Gate = Located<GateFields & { gate: string }>;
type Rule = Located<RuleFields & { rule: string }>;
type Budget = Located<BudgetFields & { budget: string }>;

/** What version 4 adds: contracts by agent and operation, and what reads them. */
export type ContractNeeds = {
  receipts: Record<string, ReceiptContract>;
  briefs: Record<string, BriefContract>;
  inputs: Record<string, InputContract>;
  /** By gate name and index. */
  needs: Map<
    string,
    Omit<ContractRequirement, "agent" | "verdicts" | "since">[]
  >;
  /** Each rule or gate entry with a `where`, its compiled conditions. */
  where: Map<object, CompiledCondition[]>;
  /** Engine version 5: each evidence a requirement reads, pinned. */
  evidence: Record<string, EvidenceContract>;
  /** Engine version 5: evidence requirements, by gate name. */
  evidenceNeeds: Map<string, EvidenceNeed[]>;
};

const CONTRACT_FIELDS = ["where", "authority", "subject"] as const;

const usesContracts = (entry: RequirementEntry) =>
  entry.evidence !== undefined ||
  CONTRACT_FIELDS.some((field) => entry[field] !== undefined);

const levelOf = (compiling: Compiling, file: string) =>
  compiling.state.levels?.get(file) ?? 0;

/** A rule or gate as the contracts compiler reads a rule-file item. */
type Item = {
  entry: Rule | Gate | Budget;
  item: Record<string, unknown>;
};

/** The rules and gates that read contracts, in the order they are compiled. */
function itemsOf(compiling: Compiling): Item[] {
  const { rules, gates } = compiling.state;
  const match = (entry: RuleFields) => ({
    tool: entry.tool,
    operation: entry.operation,
    resource: entry.resource,
    where: entry.where,
  });
  return [
    ...[...rules]
      .filter(([, rule]) => rule.where !== undefined && rule.enabled !== false)
      .map(([name, rule]) => ({
        entry: rule,
        item: { rule: name, ...match(rule), effect: rule.effect },
      })),
    ...[...gates].map(([name, gate]) => ({
      entry: gate,
      item: {
        gate: name,
        ...(gate.where === undefined ? {} : match(gate)),
        requires: gate.requires,
        otherwise: gate.otherwise,
      },
    })),
    // C03: a sum is checked against the operation's declared input or result.
    ...[...compiling.state.budgets]
      .filter(([, budget]) => budget.sum && budget.enabled !== false)
      .map(([name, budget]) => ({
        entry: budget,
        item: { budget: name, sum: budget.sum, unit: budget.unit },
      })),
  ];
}

const tooLow = `Contract fields need required_engine_version: ${CONTRACTS_ENGINE_LEVEL} in this file, so older engines refuse it.`;
const tooLowFor = (what: string) =>
  `${what} need required_engine_version: ${ACCOUNTABLE_ENGINE_LEVEL} in this file, so older engines refuse it.`;

/** Contract fields need engine version 4 in their own file, so older engines refuse it. */
function checkLevels(compiling: Compiling, items: Item[]) {
  const { contracts } = compiling.state;
  const { collector } = compiling;
  if (contracts && levelOf(compiling, contracts.file) < CONTRACTS_ENGINE_LEVEL)
    collector.error(pick(contracts, [["contracts"]], "key"), tooLow);
  if (
    contracts?.contracts.evidence !== undefined &&
    levelOf(compiling, contracts.file) < ACCOUNTABLE_ENGINE_LEVEL
  )
    collector.error(
      pick(contracts, [["contracts", "evidence"]], "key"),
      tooLowFor("Evidence contracts"),
    );
  for (const { entry } of items) {
    if ("budget" in entry) {
      // Its level is checked with the budget; a sum reads a declared shape.
      if (!contracts)
        collector.error(
          pick(entry, [["sum"]], "key"),
          "sum reads an operation's declared input or result; declare it in a contracts entry.",
        );
      continue;
    }
    const low = levelOf(compiling, entry.file) < CONTRACTS_ENGINE_LEVEL;
    if (entry.where !== undefined) {
      if (low) collector.error(pick(entry, [["where"]], "key"), tooLow);
      if (!contracts)
        collector.error(
          pick(entry, [["where"]], "key"),
          "where reads a declared input or brief; declare it in a contracts entry.",
        );
    }
    const requires = "gate" in entry ? (entry.requires ?? []) : [];
    requires.forEach((need, index) => {
      if (!usesContracts(need)) return;
      const at = pick(entry, [["requires", index]]);
      if (need.evidence !== undefined) {
        if (levelOf(compiling, entry.file) < ACCOUNTABLE_ENGINE_LEVEL)
          collector.error(at, tooLowFor("Evidence requirements"));
        if (!contracts)
          collector.error(
            at,
            `This requirement reads the evidence ${need.evidence}; declare it in a contracts entry.`,
          );
        return;
      }
      if (low) collector.error(at, tooLow);
      if (!contracts)
        collector.error(
          at,
          `This requirement reads ${need.agent}'s receipt contract; declare it in a contracts entry.`,
        );
    });
  }
}

/** The contracts entry as the contracts compiler reads nodrail.yaml and Agents. */
function sources(compiling: Compiling, items: Item[]) {
  const entry = compiling.state.contracts?.contracts ?? {};
  const agents: Record<string, object> = { ...entry.agents };
  // A receipt named like an agent is that agent's, as in nodrail.yaml.
  for (const name of Object.keys(entry.receipts ?? {}))
    agents[name] ??= { receipt: name };
  return {
    manifest: {
      shapes: entry.shapes,
      receipts: entry.receipts,
      evidence: entry.evidence,
      connections: entry.connections,
    },
    resources: Object.entries(agents).map(([name, spec]) => ({
      apiVersion: "nodrail.com/v1alpha1",
      kind: "Agent",
      metadata: { name },
      spec,
    })),
    // Each file's own level is checked above, at its own line.
    policy: [
      { required_engine_version: ACCOUNTABLE_ENGINE_LEVEL },
      ...items.map(({ item }) => item),
    ],
  };
}

/** Where a contracts compiler issue is, in the rule files. */
function placeOf(compiling: Compiling, items: Item[], path: Path) {
  const [root, index, ...rest] = path;
  const contracts = compiling.state.contracts!;
  const item = typeof index === "number" ? items[index - 1] : undefined;
  if (root === "policy" && item)
    return pick(item.entry, [rest, rest.slice(0, 1), []]);
  if (root === "resources") return pick(contracts, [["contracts", "agents"]]);
  const inside = path.slice(1);
  return pick(contracts, [["contracts", ...inside], ["contracts"]]);
}

function needsOf(
  items: Item[],
  receipts: Record<string, ReceiptContract>,
  conditions: Map<string, CompiledCondition[]>,
): ContractNeeds["needs"] {
  const needs: ContractNeeds["needs"] = new Map();
  items.forEach(({ entry }, index) => {
    if (!("gate" in entry)) return;
    // Indexed like the gate's `requires`, evidence requirements included.
    needs.set(
      entry.gate,
      (entry.requires ?? []).map((need, at) => ({
        contract: need.agent
          ? (receipts[agentName(need.agent)]?.contract ?? null)
          : null,
        where: conditions.get(`policy.${index + 1}.requires.${at}`) ?? [],
        authority: "agent-reported" as const,
        subject: need.subject === "revision" ? ("revision" as const) : null,
      })),
    );
  });
  return needs;
}

/** Each gate's evidence requirements, pinned to the evidence contract. */
function evidenceNeedsOf(
  items: Item[],
  evidence: Record<string, EvidenceContract>,
  conditions: Map<string, CompiledCondition[]>,
) {
  const needs = new Map<string, EvidenceNeed[]>();
  items.forEach(({ entry }, index) => {
    if (!("gate" in entry)) return;
    const found = (entry.requires ?? []).flatMap((need, at) => {
      const contract = need.evidence ? evidence[need.evidence] : undefined;
      if (!need.evidence || !contract) return [];
      return [
        {
          evidence: need.evidence,
          contract: contract.contract,
          where: conditions.get(`policy.${index + 1}.requires.${at}`) ?? [],
          authority: need.authority as EvidenceNeed["authority"],
          subject: "revision" as const,
        },
      ];
    });
    if (found.length) needs.set(entry.gate, found);
  });
  return needs;
}

/** Each declared evidence, pinned by its contract digest, with its producers. */
function evidenceContracts(
  contracts: CompiledContracts,
  declared: Record<string, unknown> | undefined,
): Record<string, EvidenceContract> {
  const found: Record<string, EvidenceContract> = {};
  for (const binding of contracts.bindings) {
    if (!binding.name.startsWith("evidence:") || !binding.shape) continue;
    const compiled = contracts.shapes[binding.shape];
    const name = binding.name.slice("evidence:".length);
    const raw = declared?.[name] as
      | {
          producers?: { class: string; verifier?: string }[];
          subject?: string;
        }
      | undefined;
    if (!compiled || !raw?.producers) continue;
    found[name] = {
      name: binding.name,
      contract: compiled.contract,
      shape: compiled.shape,
      producers: raw.producers.map((producer) => ({
        class: producer.class as "runtime-observed" | "externally-verified",
        verifier: producer.verifier ?? null,
      })),
      subject: raw.subject === "revision" ? "revision" : "none",
    };
  }
  return found;
}

type Outputs = {
  rules: { output: unknown }[];
  gates: { output: unknown }[];
  budgets: { output: unknown }[];
};

/** Receipts always; briefs and inputs only when declared. */
function declared(contracts: ContractNeeds | null | undefined) {
  if (!contracts) return { receipts: {} };
  return {
    receipts: contracts.receipts,
    ...(Object.keys(contracts.briefs).length
      ? { briefs: contracts.briefs }
      : {}),
    ...(Object.keys(contracts.inputs).length
      ? { inputs: contracts.inputs }
      : {}),
  };
}

const isNumericOutput = (output: unknown) =>
  typeof output === "object" && output !== null && "measure" in output;

/**
 * The document to check: version 3 with contracts, 2 with gates or budgets,
 * else 1. Only a document that needs a version has it, so every other stays
 * readable by older engines; briefs and inputs appear only when declared.
 */
export function documentOf(
  compiled: Outputs,
  contracts: ContractNeeds | null | undefined,
) {
  const outputs = (items: { output: unknown }[]) =>
    items.map((item) => item.output);
  const rules = outputs(compiled.rules);
  const all = outputs(compiled.budgets);
  const runs = {
    gates: outputs(compiled.gates),
    budgets: all.filter((budget) => !isNumericOutput(budget)),
  };
  const limits = all.filter(isNumericOutput);
  const evidence = contracts?.evidence ?? {};
  const accountable =
    limits.length > 0 ||
    Object.keys(evidence).length > 0 ||
    (contracts?.evidenceNeeds.size ?? 0) > 0;
  if (accountable)
    return {
      version: 4,
      rules,
      ...runs,
      limits,
      ...declared(contracts),
      evidence,
    };
  if (contracts) return { version: 3, rules, ...runs, ...declared(contracts) };
  if (runs.gates.length || runs.budgets.length)
    return { version: 2, rules, ...runs };
  return { version: 1, rules };
}

/**
 * The contracts version 4 adds and what reads them, or null when the files
 * use none of it: then the document is what it was before.
 */
export function compileGateContracts(
  compiling: Compiling,
): ContractNeeds | null {
  const items = itemsOf(compiling);
  const used = items.some(
    ({ entry }) =>
      ("where" in entry && entry.where !== undefined) ||
      "budget" in entry ||
      ("gate" in entry && (entry.requires ?? []).some(usesContracts)),
  );
  if (!compiling.state.contracts && !used) return null;
  checkLevels(compiling, items);
  if (!compiling.state.contracts) return null;
  const result = compileContracts(sources(compiling, items));
  for (const issue of result.issues)
    compiling.collector.error(
      placeOf(compiling, items, issue.path),
      `${issue.message} (${issue.code})`,
    );
  if (!result.contracts) return null;
  const receipts = receiptContracts(result.contracts);
  const evidence = evidenceContracts(
    result.contracts,
    compiling.state.contracts.contracts.evidence,
  );
  const conditions = new Map(
    result.contracts.consumers
      .filter(({ consumer }) => consumer === "C01" || consumer === "C02")
      .map((consumer) => [consumer.at, consumer.conditions]),
  );
  const where = new Map<object, CompiledCondition[]>();
  items.forEach(({ entry }, index) => {
    const compiled = conditions.get(`policy.${index + 1}`);
    if ("where" in entry && entry.where !== undefined && compiled)
      where.set(entry, compiled);
  });
  return {
    receipts,
    briefs: briefContracts(result.contracts),
    inputs: inputContracts(result.contracts),
    needs: needsOf(items, receipts, conditions),
    where,
    evidence,
    evidenceNeeds: evidenceNeedsOf(items, evidence, conditions),
  };
}
