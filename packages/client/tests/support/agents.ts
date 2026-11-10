import {
  Agent,
  run,
  setTracingDisabled,
  Usage,
  type Model,
} from "@openai/agents";
import { generateText, stepCountIs, type ToolSet } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import {
  createAgent,
  FakeToolCallingModel,
  type AgentMiddleware,
} from "langchain";

setTracingDisabled(true);

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

/**
 * Each framework's real agent loop, with only the model replaced by one that
 * asks for this tool and then stops. Returns what the agent got back from it.
 */
export async function runAiSdk(tools: ToolSet, name: string, input: object) {
  let calls = 0;
  const model = new MockLanguageModelV4({
    doGenerate: async () => {
      calls += 1;
      return calls === 1
        ? {
            content: [
              {
                type: "tool-call" as const,
                toolCallId: "call-1",
                toolName: name,
                input: JSON.stringify(input),
              },
            ],
            finishReason: { unified: "tool-calls" as const, raw: undefined },
            usage,
            warnings: [],
          }
        : {
            content: [{ type: "text" as const, text: "done" }],
            finishReason: { unified: "stop" as const, raw: undefined },
            usage,
            warnings: [],
          };
    },
  });
  const result = await generateText({
    model,
    tools,
    prompt: "go",
    stopWhen: stepCountIs(3),
  });
  return result.steps[0]?.toolResults[0]?.output;
}

export async function runLangChain(
  tools: unknown[],
  name: string,
  input: object,
  middleware: AgentMiddleware[] = [],
) {
  const agent = createAgent({
    model: new FakeToolCallingModel({
      toolCalls: [[{ name, args: input, id: "call-1", type: "tool_call" }], []],
    }),
    tools: tools as never,
    middleware,
  });
  const { messages } = await agent.invoke({
    messages: [{ role: "user", content: "go" }],
  });
  const reply = messages.find((message) => message.getType() === "tool");
  return reply?.content;
}

function agentsModel(name: string, input: object): Model {
  let calls = 0;
  return {
    getResponse: async () => {
      calls += 1;
      return calls === 1
        ? {
            usage: new Usage(),
            output: [
              {
                type: "function_call",
                callId: "call-1",
                name,
                status: "completed",
                arguments: JSON.stringify(input),
              },
            ],
          }
        : {
            usage: new Usage(),
            output: [
              {
                type: "message",
                role: "assistant",
                status: "completed",
                content: [{ type: "output_text", text: "done" }],
              },
            ],
          };
    },
    getStreamedResponse: () => {
      throw new Error("not used");
    },
  } as Model;
}

export async function runOpenAiAgents(
  tools: unknown[],
  name: string,
  input: object,
) {
  const agent = new Agent({
    name: "test",
    instructions: "go",
    tools: tools as never,
    model: agentsModel(name, input),
  });
  const result = await run(agent, "go");
  const item = result.newItems.find(
    (entry) => entry.type === "tool_call_output_item",
  ) as unknown as { output: unknown } | undefined;
  return item?.output;
}
