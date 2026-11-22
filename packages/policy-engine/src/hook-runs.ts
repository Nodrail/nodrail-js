// What a hook needs to place a call in a run: which run it belongs to, how the
// step's agent is named, and the receipt block an agent ended with. No zod and
// no YAML: hooks bundle this and must stay small.
import { receiptBlock } from "./receipt-block.ts";
import { headerNaming, readHeaderBlock } from "./shapes/receipt-header.ts";

export { agentName } from "./names.ts";
export { MAX_RECEIPT_TEXT, receiptBlock } from "./receipt-block.ts";
export { ledgerDirectory, nodrailDirectory, runKey } from "./run-key.ts";

/** The tool a Claude Code subagent ends with in `auto` permission mode. */
export const HANDBACK_TOOL = "SubagentHandback";

/**
 * How a hand-back is named to the rules: `claude-code subagenthandback`.
 * It delivers the subagent's final report to its caller, as a stop does,
 * and acts on nothing else, so when no rule covers it it goes ahead: a rule
 * may still deny it or send it to a person, and a receipt contract refuses
 * an invalid receipt. Blocking it by default would strand every subagent
 * that ends this way.
 */
export const HANDBACK_ACTION = {
  tool: "claude-code",
  operation: "subagenthandback",
} as const;

/**
 * The receipt that ends a message, as written, for a hook that sends it on
 * and leaves reading it to the contract: the fenced `nodrail-receipt` block,
 * else a flat header block (`RECEIPT <agent>`, `RECEIPT-<agent>` or any
 * title the grammar allows, then `key: value` lines) naming the agent that
 * was dispatched. Null when neither ends the message or the block is over
 * 8 KiB. The receiver applies the configured format and title, so a block
 * sent here can still be refused there.
 */
export function receiptText(message: string, agent: string): string | null {
  const fenced = receiptBlock(message);
  if (fenced !== null) return fenced;
  return readHeaderBlock(message, headerNaming(agent))?.text ?? null;
}
