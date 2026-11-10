import { randomUUID } from "node:crypto";
import { describeNamedTool } from "@nodrail/policy-engine/actions";
import { blockedText } from "./blocked-text.ts";
import {
  resolveConnection,
  waitMsFrom,
  type Environment,
} from "./connection.ts";
import {
  authorize,
  NodrailClient,
  type ActionDescriptor,
  type Decision,
} from "./index.ts";
import {
  adapterFor,
  canRun,
  isAsyncGenerator,
  isGuarded,
  isToolWithoutCode,
  uncovered,
  type ToolAdapter,
  type ToolHooks,
} from "./tool-shapes.ts";

export const SDK_VERSION = "0.1.5";

type Blocked = Extract<Decision, { allowed: false }>;

/** Thrown instead of running anything, when `onBlocked` is "throw". */
export class NodrailBlockedError extends Error {
  override readonly name = "NodrailBlockedError";
  readonly code: string;
  readonly reference: string | null;
  constructor(decision: Blocked) {
    super(blockedText(decision));
    this.code = decision.code;
    this.reference = decision.reference;
  }
}

/** The shorthand accepted everywhere an action is described. */
export type ActionInput = {
  tool: string;
  operation: string;
  /** "acme/app", or a kind and id when rules need to tell kinds apart. */
  resource?: string | { kind: string; id: string };
  params?: Record<string, unknown>;
};

export type OnBlocked =
  "return" | "throw" | ((error: NodrailBlockedError) => unknown);

/** Lets a tool name what it acts on, so rules can match that and not just its name. */
export type Describe = (
  input: unknown,
  name: string,
) => Partial<ActionInput> | undefined;

type AnyFunction = (...args: never[]) => unknown;

/**
 * A guarded plain function has to ask first, so it always returns a promise.
 * Async generators stay generators, and framework tools keep their own type.
 */
export type GuardedFunction<F> = F extends (...args: infer A) => infer R
  ? [R] extends [AsyncIterable<unknown>]
    ? F
    : (...args: A) => Promise<Awaited<R>>
  : F;

/** What `guard` returns for each kind of input. */
export type Guarded<T> = T extends AnyFunction
  ? GuardedFunction<T>
  : T extends readonly (infer Item)[]
    ? Item extends AnyFunction
      ? GuardedFunction<Item>[]
      : T
    : T extends Record<string, unknown>
      ? T[keyof T] extends AnyFunction
        ? { [Name in keyof T]: GuardedFunction<T[Name]> }
        : T
      : T;

export type GuardOptions = {
  /** What a blocked tool does. By default the agent reads why as the result. */
  onBlocked?: OnBlocked;
  /** One function for every tool, or one per tool name. */
  describe?: Describe | Record<string, Describe>;
  /** Names a bare function. Otherwise its own name is used. */
  name?: string;
  waitMs?: number;
};

export type NodrailOptions = {
  url?: string;
  credential?: string;
  /** Shown on the agent's page in Nodrail. */
  adapterVersion?: string;
  /** How long a call waits for a person. Default 5 minutes. */
  waitMs?: number;
  onBlocked?: OnBlocked;
  env?: Environment;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function toDescriptor(action: ActionInput): ActionDescriptor {
  const { tool, operation, resource, params = {} } = action;
  return {
    tool,
    operation,
    resource:
      typeof resource === "string"
        ? { kind: "resource", id: resource }
        : (resource ?? { kind: "tool", id: `${tool}.${operation}` }),
    params: params as ActionDescriptor["params"],
  };
}

/** Plain JSON, or an error: what can't be shown to a reviewer can't be approved. */
const asJson = (value: unknown) =>
  JSON.parse(JSON.stringify(value ?? {})) as unknown;

/** How long a tool's result may wait on the report about it. */
const REPORT_WAIT_MS = 1500;

export class Nodrail {
  private client: NodrailClient | null;
  private readonly options: NodrailOptions;
  private readonly env: Environment;
  private readonly onBlocked: OnBlocked;
  private readonly sleep: NodrailOptions["sleep"];

  constructor(options: NodrailOptions = {}) {
    this.options = options;
    this.env = options.env ?? process.env;
    this.client = this.connect();
    this.onBlocked = options.onBlocked ?? "return";
    this.sleep = options.sleep;
  }

  /**
   * Without a credential each call is blocked rather than failing at startup,
   * and the next call looks again: an application that loads its secrets after
   * importing its tools still gets checked calls once they are there.
   */
  private connect() {
    const found = resolveConnection(this.env);
    const credential = this.options.credential ?? found.credential;
    return credential
      ? new NodrailClient({
          url: this.options.url ?? found.url,
          credential,
          adapterVersion:
            this.options.adapterVersion ?? `typescript-sdk/${SDK_VERSION}`,
          fetch: this.options.fetch,
        })
      : null;
  }

  private decide(
    descriptor: ActionDescriptor,
    waitMs = this.options.waitMs ?? waitMsFrom(this.env),
  ): Promise<Decision> {
    this.client ??= this.connect();
    if (!this.client)
      return Promise.resolve({
        allowed: false,
        code: "NOT_CONFIGURED",
        reason: null,
        reference: null,
      });
    return authorize(this.client, descriptor, randomUUID(), {
      waitMs,
      sleep: this.sleep,
    });
  }

  /** Asks without running anything. Run the action only on `allowed: true`. */
  check(action: ActionInput, options: { waitMs?: number } = {}) {
    try {
      return this.decide(
        toDescriptor({
          ...action,
          params: asJson(action.params) as Record<string, unknown>,
        }),
        options.waitMs,
      );
    } catch {
      return Promise.resolve<Decision>(invalidAction);
    }
  }

  /** Reports what happened. A lost report never disturbs the action. */
  async report(
    decision: Extract<Decision, { allowed: true }>,
    outcome: "success" | "failure",
  ) {
    const sent = this.client
      ?.report(decision.actionId, {
        key: randomUUID(),
        outcome,
        permitId: decision.permitId,
      })
      .catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      sent,
      new Promise((done) => {
        timer = setTimeout(done, REPORT_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
  }

  private async execute<T>(
    decision: Extract<Decision, { allowed: true }>,
    action: () => T | Promise<T>,
  ): Promise<T> {
    try {
      const result = await action();
      await this.report(decision, "success");
      return result;
    } catch (error) {
      await this.report(decision, "failure");
      throw error;
    }
  }

  /** Runs `action` only if allowed, and throws NodrailBlockedError if not. */
  async run<T>(action: ActionInput, perform: () => T | Promise<T>): Promise<T> {
    const decision = await this.check(action);
    if (!decision.allowed) throw new NodrailBlockedError(decision);
    return this.execute(decision, perform);
  }

  private hooksFor(name: string, options: GuardOptions): ToolHooks {
    const onBlocked = options.onBlocked ?? this.onBlocked;
    const describe = describerFor(options.describe, name);

    const decideFor = (input: unknown): Promise<Decision> => {
      let descriptor: ActionDescriptor | null;
      try {
        const args = asJson(input);
        descriptor = describeNamedTool(
          name,
          isRecord(args) ? args : { value: args },
        );
        const override = describe?.(args, name);
        if (descriptor && override)
          descriptor = {
            ...descriptor,
            ...toDescriptor({
              tool: descriptor.tool,
              operation: descriptor.operation,
              resource: descriptor.resource,
              params: descriptor.params as Record<string, unknown>,
              ...override,
            }),
          };
      } catch {
        return Promise.resolve(invalidAction);
      }
      return descriptor
        ? this.decide(descriptor, options.waitMs)
        : Promise.resolve(invalidAction);
    };

    const refuse = (decision: Blocked, asResult: (text: string) => unknown) => {
      const error = new NodrailBlockedError(decision);
      if (onBlocked === "throw") throw error;
      return typeof onBlocked === "function"
        ? onBlocked(error)
        : asResult(error.message);
    };

    const report = this.report.bind(this);
    return {
      around: async (input, perform, asResult = (text) => text) => {
        const decision = await decideFor(input);
        return decision.allowed
          ? this.execute(decision, perform)
          : refuse(decision, asResult);
      },
      stream: async function* (input, perform) {
        const decision = await decideFor(input);
        if (!decision.allowed) {
          yield refuse(decision, (text) => text);
          return;
        }
        try {
          yield* perform();
        } catch (error) {
          await report(decision, "failure");
          throw error;
        }
        await report(decision, "success");
      },
    };
  }

  /**
   * Puts Nodrail in front of tools, whichever framework they come from: pass
   * one tool, an array, a record of tools, or a plain function. What comes back
   * goes wherever the original went: framework tools keep their type, and a
   * plain function returns a promise.
   */
  guard<T>(target: T, options: GuardOptions = {}): Guarded<T> {
    return this.guardNamed(target, undefined, options) as Guarded<T>;
  }

  /**
   * Puts every tool an MCP server registers from now on behind the check,
   * under the name it registers with. Call it before registering tools: ones
   * already registered aren't covered, so that throws.
   */
  guardMcpServer<S extends McpServerLike>(
    server: S,
    options: GuardOptions = {},
  ): S {
    const registered = (server as { _registeredTools?: object })
      ._registeredTools;
    if (registered && Object.keys(registered).length)
      throw new TypeError(
        "Nodrail: guard the MCP server before registering its tools; ones already registered wouldn't be checked.",
      );
    const register = server.registerTool.bind(server);
    server.registerTool = ((name: string, ...rest: unknown[]) => {
      const tool = (register as (...args: unknown[]) => unknown)(name, ...rest);
      this.guardNamed({ [name]: tool }, undefined, options);
      return tool;
    }) as S["registerTool"];
    return server;
  }

  private guardNamed(
    target: unknown,
    key: string | undefined,
    options: GuardOptions,
  ): unknown {
    if (Array.isArray(target))
      return target.map((item) => this.guardNamed(item, undefined, options));
    if (typeof target === "function")
      return this.guardPlainFunction(
        target as (...args: unknown[]) => unknown,
        key,
        options,
      );
    if (!isRecord(target))
      throw new TypeError(
        "Nodrail: this is not a tool, so it can't be guarded.",
      );
    if (isGuarded(target)) return target;
    const adapter = adapterFor(target);
    if (adapter) return this.guardShaped(target, adapter, key, options);
    return this.guardUnshaped(target, key, options);
  }

  private guardPlainFunction(
    target: (...args: unknown[]) => unknown,
    key: string | undefined,
    options: GuardOptions,
  ) {
    const name = options.name ?? key ?? target.name;
    if (!name)
      throw new TypeError(
        "Nodrail: this function has no name. Pass { name } so rules can refer to it.",
      );
    return guardFunction(target, this.hooksFor(name, options));
  }

  /** A tool in a shape a framework uses, put behind the check. */
  private guardShaped(
    target: Record<string, unknown>,
    adapter: ToolAdapter,
    key: string | undefined,
    options: GuardOptions,
  ) {
    // A second way to run it would be left unchecked.
    const others = uncovered(target, adapter);
    if (others.length)
      throw new TypeError(
        `Nodrail: ${key ? `"${key}"` : "this tool"} can also run through ${others.join(", ")}, which this shape doesn't cover. Pass one function instead.`,
      );
    const name = adapter.name(target) ?? key;
    if (!name)
      throw new TypeError(
        "Nodrail: this tool has no name, so rules can't refer to it.",
      );
    return adapter.wrap(target, this.hooksFor(name, options));
  }

  /**
   * Anything else: a tool with no code here passes through, a record of tools
   * is guarded tool by tool, and the rest is refused. Silently leaving a tool
   * unguarded would look like it was protected.
   */
  private guardUnshaped(
    target: Record<string, unknown>,
    key: string | undefined,
    options: GuardOptions,
  ): unknown {
    const which = key ? `"${key}"` : "this object";
    if (canRun(target))
      throw new TypeError(
        `Nodrail: ${which} has code that runs, in a shape this version doesn't recognise. Pass its function instead, or use nodrail.run().`,
      );
    if (isToolWithoutCode(target)) return target;
    if (key !== undefined || !isCollection(target))
      throw new TypeError(
        `Nodrail: don't know how to guard ${which}. Pass its function instead, or use nodrail.run().`,
      );
    return Object.fromEntries(
      Object.entries(target).map(([name, tool]) => [
        name,
        this.guardNamed(tool, name, options),
      ]),
    );
  }
}

/**
 * The describe function for one tool. Only the caller's own entries count: a
 * tool named "constructor" must not find Object's, which would hand back the
 * model's own arguments as the description.
 */
export function describerFor(
  describe: GuardOptions["describe"],
  name: string,
): Describe | undefined {
  if (typeof describe === "function") return describe;
  if (!describe || !Object.hasOwn(describe, name)) return undefined;
  const entry = describe[name];
  return typeof entry === "function" ? entry : undefined;
}

const invalidAction: Decision = {
  allowed: false,
  code: "INVALID_ACTION",
  reason: null,
  reference: null,
};

const isCollection = (value: Record<string, unknown>) =>
  Object.keys(value).length > 0 &&
  Object.values(value).every(
    (item) => typeof item === "function" || isRecord(item),
  );

const argsAsInput = (args: unknown[]) =>
  args.length <= 1 ? (args[0] ?? {}) : { args };

function guardFunction(fn: (...args: unknown[]) => unknown, hooks: ToolHooks) {
  if (isAsyncGenerator(fn))
    return function (this: unknown, ...args: unknown[]) {
      return hooks.stream(
        argsAsInput(args),
        () => fn.apply(this, args) as AsyncIterable<unknown>,
      );
    };
  return function (this: unknown, ...args: unknown[]) {
    return hooks.around(argsAsInput(args), () => fn.apply(this, args));
  };
}

/** The part of an MCP SDK server that guardMcpServer needs. */
export type McpServerLike = { registerTool: (...args: never[]) => unknown };

export const createNodrail = (options?: NodrailOptions) => new Nodrail(options);

let shared: Nodrail | null = null;

/** `nodrail.guardMcpServer(server)` with the connection taken from the environment. */
export function guardMcpServer<S extends McpServerLike>(
  server: S,
  options?: GuardOptions,
): S {
  shared ??= new Nodrail();
  return shared.guardMcpServer(server, options);
}

/** `guard(tools)` with the connection taken from the environment. */
export function guard<T>(target: T, options?: GuardOptions): Guarded<T> {
  shared ??= new Nodrail();
  return shared.guard(target, options);
}
