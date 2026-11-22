// What a call tells Cloud about its declared brief or input (S02, S03), so
// Cloud can read a rule's `where` from the action itself, bound to its
// digest: the started agent's brief as its reporting projection
// (`params.brief`: only `report: true` fields, secret and pii never), and an
// operation's input with every classified field shown as `[classified]`.
// The engine reads both exactly as the local hook does; nothing here judges.
import {
  checkContracts,
  projectShape,
  projectValue,
  type BriefContract,
  type InputContract,
} from "@nodrail/policy-engine/contracts";
import type { PolicyDocument } from "@nodrail/policy-engine";
import type { ToolInput } from "@nodrail/policy-engine/actions";
import type { ActionDescriptor } from "./protocol.ts";

/**
 * The published brief and input contracts, as a version 3 policy document
 * carries them: briefs by agent, inputs by `<tool>.<operation>`.
 */
export type CallContracts = {
  briefs?: Record<string, BriefContract>;
  inputs?: Record<string, InputContract>;
};

export type ContractFields = { action: ActionDescriptor } | { refusal: string };

/** A call refused here, before Cloud is asked: the reason names paths and codes. */
export const contractRefused = (reason: string) => ({
  allowed: false as const,
  code: "CONTRACT_REFUSED",
  reason,
  reference: null,
});

/**
 * The action as Cloud should see it, or why the call is refused before it
 * is ever sent: a brief or input that doesn't follow its contract, or a
 * brief the host doesn't show. Without contracts the action is unchanged.
 */
export function withContractFields(
  action: ActionDescriptor,
  input: ToolInput,
  contracts: CallContracts | null | undefined,
): ContractFields {
  if (!contracts || (!contracts.briefs && !contracts.inputs)) return { action };
  // Only these three keys are read; rules stay Cloud's.
  const document = {
    version: 3,
    rules: [],
    gates: [],
    budgets: [],
    receipts: {},
    ...contracts,
  } as unknown as PolicyDocument;
  const checked = checkContracts(document, action, input);
  if ("refusal" in checked) return checked;
  const brief = checked.values?.brief;
  const contract = brief ? contracts.briefs?.[action.resource.id] : undefined;
  if (!brief || !contract) return { action: checked.action };
  const projected = projectValue(
    projectShape(contract.shape),
    brief as Record<string, unknown>,
  );
  return {
    action: {
      ...checked.action,
      params: {
        ...checked.action.params,
        brief: projected,
      } as ActionDescriptor["params"],
    },
  };
}
