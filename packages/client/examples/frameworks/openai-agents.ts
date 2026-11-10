// An existing OpenAI Agents SDK agent, with Nodrail added: the two marked lines.
import { guard } from "@nodrail/client"; // 1. import
import { Agent, run, tool } from "@openai/agents";
import { z } from "zod";

const refundOrder = tool({
  name: "refund_order",
  description: "Refund a customer's order",
  parameters: z.object({ orderId: z.string(), amount: z.number() }),
  execute: async ({ orderId, amount }) => `Refunded ${amount} on ${orderId}`,
});

const agent = new Agent({
  name: "Support",
  instructions: "Help customers with their orders.",
  model: "gpt-5",
  tools: guard([refundOrder]), // 2. wrap the tools you already pass
});

export const answer = async (message: string) =>
  (await run(agent, message)).finalOutput;
