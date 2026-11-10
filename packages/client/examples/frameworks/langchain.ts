// An existing LangChain agent, with Nodrail added: the two marked lines.
import { guard } from "@nodrail/client"; // 1. import
import { createAgent, tool } from "langchain";
import { z } from "zod";

const refundOrder = tool(
  async ({ orderId, amount }) => `Refunded ${amount} on ${orderId}`,
  {
    name: "refund_order",
    description: "Refund a customer's order",
    schema: z.object({ orderId: z.string(), amount: z.number() }),
  },
);

export const agent = createAgent({
  model: "openai:gpt-5",
  tools: guard([refundOrder]), // 2. wrap the tools you already pass
});
