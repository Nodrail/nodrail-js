// Your own agent loop, with no framework: guard the function that does the work.
import { guard } from "@nodrail/client";

async function refundOrder(input: { orderId: string; amount: number }) {
  return `Refunded ${input.amount} on ${input.orderId}`;
}

// Same arguments; it now asks Nodrail first, so it always returns a promise.
export const tools = guard({ refundOrder });

// When the model asks for a tool, call it as before.
export const result = await tools.refundOrder({ orderId: "A1", amount: 20 });
