// Reading the receipt an agent ends its work with:
//
//   ```nodrail-receipt
//   verdict: pass
//   findings: [correctness]
//   ```
//
// It counts only as the last thing in the message, so a receipt quoted in the
// middle of a report, or an example of one, never settles a step.
import { parse } from "yaml";
import { z } from "zod";
import { readReceiptBlock } from "./receipt-block.ts";
import { verdict } from "./policies.ts";

export { MAX_RECEIPT_TEXT, receiptBlock } from "./receipt-block.ts";

export type Receipt = {
  verdict: string | null;
  findings: string[];
  usage: { tokens?: number; usd?: number };
};

const word = (value: unknown) =>
  typeof value === "string"
    ? value.trim().toLowerCase().replace(/\s+/g, "_")
    : null;

const body = z
  .object({
    verdict: z.unknown().optional(),
    findings: z.array(z.unknown()).max(50).optional(),
    tokens: z.number().nonnegative().finite().optional(),
    usd: z.number().nonnegative().finite().optional(),
  })
  // Other keys are the agent's notes. `agent` is ignored: who ran comes from the dispatch.
  .passthrough();

/**
 * The receipt at the very end of a message, or null when there isn't one.
 * Only the end of the message is read, and a block longer than
 * MAX_RECEIPT_TEXT is no receipt, here and in Cloud alike.
 */
export function parseReceipt(message: string): Receipt | null {
  const text = readReceiptBlock(message)?.body;
  if (text === undefined) return null;
  let raw: unknown;
  try {
    raw = parse(text, { schema: "core", uniqueKeys: true });
  } catch {
    return null;
  }
  const parsed = body.safeParse(raw);
  if (!parsed.success) return null;
  const said = verdict.safeParse(word(parsed.data.verdict));
  const findings = (parsed.data.findings ?? [])
    .map(word)
    .filter(
      (item): item is string =>
        item !== null && verdict.safeParse(item).success,
    );
  const { tokens, usd } = parsed.data;
  return {
    verdict: said.success ? said.data : null,
    findings,
    usage: {
      ...(tokens === undefined ? {} : { tokens }),
      ...(usd === undefined ? {} : { usd }),
    },
  };
}
