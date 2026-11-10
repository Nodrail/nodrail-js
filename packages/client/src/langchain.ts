import { createMiddleware, ToolMessage, type AgentMiddleware } from "langchain";
import {
  describerFor,
  Nodrail,
  type GuardOptions,
  type NodrailOptions,
} from "./sdk.ts";
import { isGuarded } from "./tool-shapes.ts";

/**
 * Checks every tool call a `createAgent` agent makes, including tools added
 * while it runs. The alternative to `guard(tools)`, not an addition to it.
 */
export function nodrailMiddleware(
  options: NodrailOptions & Pick<GuardOptions, "describe"> = {},
): AgentMiddleware {
  const nodrail = new Nodrail(options);
  return createMiddleware({
    name: "NodrailMiddleware",
    wrapToolCall: async (request, handler) => {
      const { toolCall } = request;
      const name = toolCall.name;
      if (isGuarded(request.tool)) return handler(request);

      const reply = (content: string) =>
        new ToolMessage({
          content,
          name,
          tool_call_id: toolCall.id ?? name,
          status: "error",
        });
      const run = nodrail.guard(() => handler(request), {
        name,
        describe: () =>
          describerFor(options.describe, name)?.(toolCall.args, name),
        onBlocked: (error) => reply(error.message),
      });
      return (await (run as (input: unknown) => unknown)(
        toolCall.args,
      )) as Awaited<ReturnType<typeof handler>>;
    },
  });
}
