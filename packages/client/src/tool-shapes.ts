/**
 * How each framework's tools are recognised and wrapped, by shape alone: none of
 * them is a dependency, and any library shaped the same way simply works.
 */

export type ToolHooks = {
  /** Runs `perform` if allowed. `asResult` shapes a refusal for this tool type. */
  around: (
    input: unknown,
    perform: () => unknown,
    asResult?: (text: string) => unknown,
  ) => Promise<unknown>;
  /** The same, for tools that stream partial results. */
  stream: (
    input: unknown,
    perform: () => AsyncIterable<unknown>,
  ) => AsyncGenerator<unknown>;
};

type Tool = Record<string, unknown>;
type Fn = (...args: unknown[]) => unknown;

export type ToolAdapter = {
  matches: (tool: Tool) => boolean;
  /** Every runnable member this adapter accounts for. Any other is refused. */
  covers: readonly string[];
  name: (tool: Tool) => string | undefined;
  wrap: (tool: Tool, hooks: ToolHooks) => unknown;
};

const text = (value: unknown) =>
  typeof value === "string" && value ? value : undefined;
const isFn = (value: unknown): value is Fn => typeof value === "function";

const isPlain = (value: object) => {
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
};

/**
 * Tools this module put behind the check, so wiring one twice can't ask twice.
 * Private on purpose: a tool can't mark itself as checked.
 */
const guarded = new WeakSet<object>();

export const isGuarded = (tool: unknown) =>
  typeof tool === "object" && tool !== null && guarded.has(tool);

const marked = <T extends object>(tool: T) => {
  guarded.add(tool);
  return tool;
};

/** A copy that still is what it was: classes stay instances of their class. */
function replacing(tool: Tool, patch: Tool) {
  if (isPlain(tool)) return marked({ ...tool, ...patch });
  return marked(Object.assign(Object.create(tool) as Tool, patch));
}

const parsedJson = (value: unknown) => {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return { value };
  }
};

export const isAsyncGenerator = (fn: unknown) =>
  Object.prototype.toString.call(fn) === "[object AsyncGeneratorFunction]";

const firstArgument = (args: unknown[]) => args[0];

/**
 * How a framework calls a method: where the tool's input is among its
 * arguments, and how a refusal has to look to be read as the tool's result.
 */
type CallShape = {
  inputOf?: (args: unknown[]) => unknown;
  asResult?: (text: string) => unknown;
};

/** The same tool with one method put behind the check. */
function guardMethod(
  tool: Tool,
  method: string,
  hooks: ToolHooks,
  { inputOf = firstArgument, asResult }: CallShape = {},
) {
  const original = tool[method] as Fn;
  return replacing(tool, {
    [method](this: unknown, ...args: unknown[]) {
      return hooks.around(
        inputOf(args),
        () => original.apply(this, args),
        asResult,
      );
    },
  });
}

/** What a tool that answers with content blocks says when it is blocked. */
const contentRefusal = (reason: string) => ({
  content: [{ type: "text", text: reason }],
  isError: true,
});

const adapters: ToolAdapter[] = [
  {
    // MCP SDK registered tools. The server keeps calling the very object
    // registerTool returned, so the check goes into that object, through the
    // SDK's own update(). Older versions called the function `callback`.
    matches: (tool) =>
      isFn(tool.update) && (isFn(tool.handler) || isFn(tool.callback)),
    covers: ["handler", "callback"],
    name: (tool) => text(tool.name),
    wrap: (tool, hooks) => {
      const key = isFn(tool.handler) ? "handler" : "callback";
      const checkedVersion = (run: Fn) =>
        function (this: unknown, ...args: unknown[]) {
          // Without an input schema the first argument is the request context.
          const input = tool.inputSchema !== undefined ? args[0] : {};
          return hooks.around(
            input,
            () => run.apply(this, args),
            contentRefusal,
          );
        };
      const update = tool.update as (changes: Tool) => void;
      const checked = checkedVersion(tool[key] as Fn);
      update({ callback: checked });
      if (tool[key] !== checked)
        throw new TypeError(
          "Nodrail: this MCP tool didn't take the check, so it can't be guarded.",
        );
      // A later update() can't swap the check out: a new function is checked
      // too. disable(), enable() and remove() go through here unchanged.
      tool.update = (changes: Tool) =>
        update(
          isFn(changes.callback)
            ? { ...changes, callback: checkedVersion(changes.callback) }
            : changes,
        );
      return marked(tool);
    },
  },
  {
    // LangChain and LangGraph. `_call` is what runs after validation, and it is
    // the same path whether the tool is called directly or by an agent.
    matches: (tool) => isFn(tool._call) && isFn(tool.invoke),
    // invoke, call and func all run through _call.
    covers: ["_call", "invoke", "call", "func"],
    name: (tool) => text(tool.name),
    wrap: (tool, hooks) =>
      guardMethod(tool, "_call", hooks, {
        asResult: (reason) =>
          tool.responseFormat === "content_and_artifact"
            ? [reason, undefined]
            : reason,
      }),
  },
  {
    // OpenAI Agents SDK.
    matches: (tool) => tool.type === "function" && isFn(tool.invoke),
    covers: ["invoke"],
    name: (tool) => text(tool.name),
    wrap: (tool, hooks) =>
      guardMethod(tool, "invoke", hooks, {
        inputOf: (args) => parsedJson(args[1]),
      }),
  },
  {
    // Claude Agent SDK, which answers with content blocks.
    matches: (tool) => isFn(tool.handler),
    covers: ["handler"],
    name: (tool) => text(tool.name),
    wrap: (tool, hooks) =>
      guardMethod(tool, "handler", hooks, { asResult: contentRefusal }),
  },
  {
    // OpenAI SDK `runTools`.
    matches: (tool) =>
      typeof tool.function === "object" &&
      tool.function !== null &&
      isFn((tool.function as Tool).function),
    covers: ["function"],
    name: (tool) => text((tool.function as Tool).name),
    wrap: (tool, hooks) =>
      marked({
        ...tool,
        function: guardMethod(tool.function as Tool, "function", hooks, {
          inputOf: (args) => parsedJson(args[0]),
        }),
      }),
  },
  {
    // Vercel AI SDK, Mastra, and anything else with `execute`.
    matches: (tool) => isFn(tool.execute),
    covers: ["execute"],
    name: (tool) => text(tool.name) ?? text(tool.id),
    wrap: (tool, hooks) => {
      const original = tool.execute as Fn;
      if (!isAsyncGenerator(original))
        return guardMethod(tool, "execute", hooks);
      return replacing(tool, {
        execute(this: unknown, ...args: unknown[]) {
          return hooks.stream(
            args[0],
            () => original.apply(this, args) as AsyncIterable<unknown>,
          );
        },
      });
    },
  },
  {
    // Anthropic SDK tool runner.
    matches: (tool) => isFn(tool.run),
    covers: ["run"],
    name: (tool) => text(tool.name),
    wrap: (tool, hooks) => guardMethod(tool, "run", hooks),
  },
  {
    // LlamaIndex.
    matches: (tool) => isFn(tool.call) && isNamedMetadata(tool.metadata),
    covers: ["call"],
    name: (tool) => text((tool.metadata as Tool).name),
    wrap: (tool, hooks) => guardMethod(tool, "call", hooks),
  },
];

function isNamedMetadata(value: unknown) {
  return (
    typeof value === "object" &&
    value !== null &&
    text((value as Tool).name) !== undefined
  );
}

export const adapterFor = (tool: Tool) =>
  adapters.find((adapter) => adapter.matches(tool));

/** Every name a framework uses for the code a tool runs. */
const RUNNABLE = [
  "execute",
  "handler",
  "invoke",
  "_call",
  "func",
  "run",
  "call",
  "callback",
  "function",
] as const;

/** The runnable members a tool has, by name. */
export const runnableMembers = (tool: Tool) =>
  RUNNABLE.filter((method) => runs(tool, method));

/** Whether this object has code of its own that could run as a tool. */
export const canRun = (tool: Tool) => runnableMembers(tool).length > 0;

function runs(tool: Tool, method: (typeof RUNNABLE)[number]) {
  const value = tool[method];
  if (isFn(value)) return true;
  // MCP task tools keep their code in handler.createTask.
  if (
    method === "handler" &&
    typeof value === "object" &&
    value !== null &&
    isFn((value as Tool).createTask)
  )
    return true;
  // OpenAI SDK `runTools` nests the function one level down.
  return (
    method === "function" &&
    typeof value === "object" &&
    value !== null &&
    isFn((value as Tool).function)
  );
}

/** Runnable members the matching adapter doesn't put behind the check. */
export const uncovered = (tool: Tool, adapter: ToolAdapter) =>
  runnableMembers(tool).filter((method) => !adapter.covers.includes(method));

/**
 * A tool definition with no code here: one that runs on a provider's servers,
 * or a schema the application answers itself. Only these pass through.
 */
export const isToolWithoutCode = (tool: Tool) =>
  !canRun(tool) &&
  ["inputSchema", "parameters", "schema", "type"].some((key) => key in tool);
