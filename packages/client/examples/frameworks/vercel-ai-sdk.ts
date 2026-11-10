// An existing Vercel AI SDK agent, with Nodrail added: the two marked lines.
import { guard } from "@nodrail/client"; // 1. import
import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";

const tools = {
  refundOrder: tool({
    description: "Refund a customer's order",
    inputSchema: z.object({ orderId: z.string(), amount: z.number() }),
    execute: async ({ orderId, amount }) => `Refunded ${amount} on ${orderId}`,
  }),
  lookupOrder: tool({
    description: "Look up an order",
    inputSchema: z.object({ orderId: z.string() }),
    execute: async ({ orderId }) => ({ orderId, status: "shipped" }),
  }),
};

export async function answer(message: string) {
  const { text } = await generateText({
    model: "openai/gpt-5",
    tools: guard(tools), // 2. wrap the tools you already pass
    stopWhen: stepCountIs(5),
    prompt: message,
  });
  return text;
}
