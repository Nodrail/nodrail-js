import { stringify } from "yaml";
import type {
  PolicyBudget,
  PolicyDocument,
  PolicyGate,
  PolicyRule,
  Requirement,
} from "./policies.ts";
import {
  renderContracts,
  renderRequirementContract,
  renderWhere,
} from "./render-contracts.ts";

/** Names must be unique in a file, so a repeated one is kept as its title. */
function namer(kind: string) {
  const seen = new Map<string, number>();
  return ({ name, id }: { name: string; id: string }) => {
    const uses = seen.get(name) ?? 0;
    seen.set(name, uses + 1);
    return uses ? { [kind]: `${name} (${id})`, title: name } : { [kind]: name };
  };
}

const matchFields = (rule: PolicyRule | PolicyGate) => ({
  id: rule.id,
  tool: rule.toolKey,
  operation: rule.operationKey,
  resource: rule.resource,
  ...(rule.conditions.length ? { condition: rule.conditions } : {}),
  // A version 3 rule's or gate's typed conditions on input or brief (C02).
  ...renderWhere("where" in rule ? rule.where : undefined),
});

const identity = (rule: PolicyRule | PolicyGate) => ({
  ...(rule.agentKey ? { agent: rule.agentKey } : {}),
  ...(rule.installationName ? { installation: rule.installationName } : {}),
  ...(rule.expiresAt ? { expires: rule.expiresAt } : {}),
});

const renderGate = (gate: PolicyGate) => ({
  ...matchFields(gate),
  ...identity(gate),
  requires: gate.requires.map((requirement: Requirement) => ({
    agent: requirement.agent,
    verdict: requirement.verdicts,
    ...(requirement.since.length ? { since: requirement.since } : {}),
    ...renderRequirementContract(requirement),
  })),
  otherwise: gate.effect,
});

const renderBudget = (budget: PolicyBudget) => ({
  id: budget.id,
  ...(budget.agent ? { step_agent: budget.agent } : {}),
  per: budget.per,
  [budget.metric]: budget.limit,
  ...(budget.warnAt === null ? {} : { warn_at: budget.warnAt }),
  otherwise: budget.effect,
});

/**
 * The opposite of compiling: rule files that compile back to this document,
 * gates and budgets included, so exporting never quietly drops a restriction.
 */
export function renderPolicies(document: PolicyDocument) {
  // Rendering would drop its evidence contracts and numeric budgets.
  if (document.version === 4)
    throw new Error(
      "A version 4 policy (evidence requirements or numeric budgets) can't be rendered back to rule files yet; keep its rule files instead.",
    );
  const rule = namer("rule");
  const items: object[] = document.rules.map((entry) => ({
    ...rule(entry),
    ...matchFields(entry),
    effect: entry.effect,
    ...identity(entry),
  }));
  if (document.version === 3)
    items.unshift(
      { required_engine_version: 4 },
      renderContracts({
        receipts: document.receipts,
        briefs: document.briefs,
        inputs: document.inputs,
      }),
    );
  if (document.version !== 1) {
    const gate = namer("gate");
    const budget = namer("budget");
    if (document.version === 2) items.unshift({ required_engine_version: 3 });
    items.push(
      ...document.gates.map((entry) => ({
        ...gate(entry),
        ...renderGate(entry),
      })),
      ...document.budgets.map((entry) => ({
        ...budget(entry),
        ...renderBudget(entry),
      })),
    );
  }
  return `# Nodrail rules. Keep each id so a rule stays the same rule when renamed.\n${items.length ? stringify(items, { lineWidth: 0 }) : "[]\n"}`;
}
