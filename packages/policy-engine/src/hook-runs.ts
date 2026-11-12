// What a hook needs to place a call in a run: which run it belongs to, how the
// step's agent is named, and the receipt block an agent ended with. No zod and
// no YAML: hooks bundle this and must stay small.
export { agentName } from "./names.ts";
export { MAX_RECEIPT_TEXT, receiptBlock } from "./receipt-block.ts";
export { runKey } from "./run-key.ts";
