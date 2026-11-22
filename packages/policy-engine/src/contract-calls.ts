// What a call's declared contracts say before the rules judge it (engine
// version 4): the brief of an agent being started (S02) and the input of a
// connection operation (S03), each read from the exact call the host is
// about to run. An invalid, missing or unobservable value is refused with
// its reason, so the agent never starts and the provider is never called;
// a valid one is what typed `where` conditions read.
import type { ToolInput } from "./actions.ts";
import type { ContractValues } from "./evaluator.ts";
import { hasContracts, type PolicyDocument } from "./policies.ts";
import type { ActionDescriptor } from "./protocol.ts";
import { readBrief, type BriefContract } from "./shapes/brief.ts";
import {
  checkInput,
  hasClassified,
  withoutClassified,
} from "./shapes/inputs.ts";

export type ContractCall =
  | { refusal: string }
  | { values: ContractValues | null; action: ActionDescriptor };

const STARTERS = new Set(["claude-code", "codex"]);

/** The agent a call starts, and its brief contract, when it has one. */
function briefOf(document: PolicyDocument, action: ActionDescriptor) {
  if (!hasContracts(document) || !document.briefs) return null;
  if (!STARTERS.has(action.tool) || action.operation !== "agent") return null;
  if (action.resource.kind !== "agent") return null;
  const contract = document.briefs[action.resource.id];
  return contract ? { agent: action.resource.id, contract } : null;
}

/**
 * The prompt a dispatch hands over, or null when the hook can't read it:
 * Claude Code's `Agent`/`Task` and Copilot's `task` (read as `Task`) send
 * it in the clear; Codex sends it encrypted.
 */
const promptOf = (action: ActionDescriptor, input: ToolInput) =>
  action.tool === "claude-code" && typeof input.prompt === "string"
    ? input.prompt
    : null;

const howToBrief = (contract: BriefContract) =>
  contract.format === "header"
    ? "with its brief's lines (`key: value`)"
    : "with a ```nodrail-brief block holding its brief";

function briefRefusal(
  agent: string,
  contract: BriefContract,
  reading: Exclude<ReturnType<typeof readBrief>, { state: "valid" }>,
) {
  if (reading.state === "unobservable")
    return `Nodrail: ${agent} is started with a declared brief, and this host doesn't show the hook the brief it hands over, so starting ${agent} is denied.`;
  return `Nodrail: the brief for ${agent} doesn't follow its contract: ${reading.reason}. Start ${agent} again ${howToBrief(contract)}.`;
}

/**
 * The call checked against its declared brief or input: refused with a
 * reason that names paths and codes, never a value; or the validated values
 * and the action with classified arguments taken out of what reviewers see.
 */
export function checkContracts(
  document: PolicyDocument,
  action: ActionDescriptor,
  input: ToolInput,
): ContractCall {
  if (!hasContracts(document)) return { values: null, action };
  const brief = briefOf(document, action);
  if (brief) {
    const reading = readBrief(
      promptOf(action, input),
      brief.contract,
      brief.agent,
    );
    return reading.state === "valid"
      ? { values: { brief: reading.value }, action }
      : { refusal: briefRefusal(brief.agent, brief.contract, reading) };
  }
  const contract = document.inputs?.[`${action.tool}.${action.operation}`];
  if (!contract) return { values: null, action };
  const checked = checkInput(contract, input);
  if (checked.state === "invalid")
    return {
      refusal: `Nodrail: the input of ${action.tool} ${action.operation} doesn't follow its contract: ${checked.reason}. So this call is denied and never reaches ${action.tool}.`,
    };
  const shown =
    hasClassified(contract.shape) && "input" in action.params
      ? {
          ...action,
          params: {
            ...action.params,
            input: withoutClassified(contract.shape, checked.value),
          } as ActionDescriptor["params"],
        }
      : action;
  return { values: { input: checked.value }, action: shown };
}
