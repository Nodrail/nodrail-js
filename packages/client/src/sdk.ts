import { randomUUID } from "node:crypto";
import { describeNamedTool } from "@nodrail/policy-engine/actions";
import { blockedText } from "./blocked-text.ts";
import { resolveConnection, type Environment } from "./connection.ts";
import { authorize } from "./authorize.ts";
import { NodrailClient, type Decision } from "./client.ts";
import type { ActionDescriptor } from "./protocol.ts";
import type { ReportOutcome } from "./protocol.ts";
import { checkMeasured, revisionAt } from "./subject.ts";
import { isTimeout, readMeasured, withinTime } from "./outcomes.ts";
import { contractRefused, withContractFields } from "./contract-fields.ts";
import { Runs, type StepOptions } from "./runs.ts";
import {
  adapterFor,
  canRun,
  guardFunction,
  isCollection,
  isGuarded,
  isToolWithoutCode,
  uncovered,
  type ToolAdapter,
  type ToolHooks,
} from "./tool-shapes.ts";

export const SDK_VERSION = "0.8.0";

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

export type {
  ActionInput,
  Describe,
  Guarded,
  GuardedFunction,
  GuardOptions,
  NodrailOptions,
  OnBlocked,
  RunOptions,
} from "./sdk-types.ts";
import type {
  RunOptions,
  ActionInput,
  Describe,
  Guarded,
  GuardOptions,
  NodrailOptions,
  OnBlocked,
} from "./sdk-types.ts";

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

/** Plain JSON, or an error: what can't be described exactly can't be decided. */
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
  private readonly runs: Runs;

  constructor(options: NodrailOptions = {}) {
    this.options = options;
    this.env = options.env ?? process.env;
    this.client = this.connect();
    this.onBlocked = options.onBlocked ?? "return";
    this.sleep = options.sleep;
    this.runs = new Runs(
      () => (this.client ??= this.connect()),
      options.run?.trim() || this.env.NODRAIL_RUN?.trim() || undefined,
    );
  }

  /** Runs `work` as part of the run `key`: its steps and calls belong to it. */
  inRun<T>(key: string, work: () => T): T {
    return this.runs.inRun(key, work);
  }

  /**
   * Runs `work` as one step of `agent` in the current run, and records how it
   * ended: a result that is, or ends with, a receipt gives the step its verdict.
   */
  step<T>(
    agent: string,
    work: () => T | Promise<T>,
    options?: StepOptions<T>,
  ): Promise<T> {
    return this.runs.step(agent, work, options);
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

  private decide(descriptor: ActionDescriptor): Promise<Decision> {
    this.client ??= this.connect();
    if (!this.client)
      return Promise.resolve({
        allowed: false,
        code: "NOT_CONFIGURED",
        reason: null,
        reference: null,
      });
    return authorize(this.client, descriptor, randomUUID(), {
      run: this.runs.current(),
      subject: this.subject(),
    });
  }

  /** How the work revision is read: the caller's way, or the git work tree. */
  private subject() {
    const { subject, cwd } = this.options;
    if (subject !== undefined) return subject;
    return revisionAt(cwd ?? process.cwd());
  }

  /** Asks without running anything. Run the action only on `allowed: true`. */
  check(action: ActionInput) {
    try {
      return this.decide(
        toDescriptor({
          ...action,
          params: asJson(action.params) as Record<string, unknown>,
        }),
      );
    } catch {
      return Promise.resolve<Decision>(invalidAction);
    }
  }

  /**
   * Reports what happened: `unknown` when it can't be told whether the call
   * took effect (a timeout), which keeps any budget reservation held. The
   * key is the permit's, so a retry or a second report changes nothing.
   * Measured amounts that aren't usable are left out whole: the budget
   * then has no reading, which it treats as unknown, never as zero. A lost
   * report never disturbs the action.
   */
  async report(
    decision: Extract<Decision, { allowed: true }>,
    outcome: ReportOutcome,
    options: { measured?: readonly unknown[] } = {},
  ) {
    const measured = options.measured && checkMeasured(options.measured);
    const sent = this.client
      ?.report(
        decision.actionId,
        {
          key: `sdk:${decision.permitId}`,
          outcome,
          permitId: decision.permitId,
          ...(measured ? { measured } : {}),
        },
        { sleep: this.sleep },
      )
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
    options: RunOptions<T> = {},
  ): Promise<T> {
    let result: T;
    try {
      result = await withinTime(action, options.timeoutMs);
    } catch (error) {
      // A timeout leaves the call's effect unknown; a thrown error says it failed.
      await this.report(decision, isTimeout(error) ? "unknown" : "failure");
      throw error;
    }
    const measured = readMeasured(options.measure, result);
    await this.report(decision, "success", { measured });
    return result;
  }

  /**
   * Runs `action` only if allowed, and throws NodrailBlockedError if not.
   * With `timeoutMs`, a call that takes longer is reported as `unknown` and
   * rejects with a TimeoutError; `measure` reads the amounts its result
   * measured, for budgets that sum them.
   */
  async run<T>(
    action: ActionInput,
    perform: () => T | Promise<T>,
    options: RunOptions<T> = {},
  ): Promise<T> {
    const decision = await this.check(action);
    if (!decision.allowed) throw new NodrailBlockedError(decision);
    return this.execute(decision, perform, options);
  }

  private hooksFor(name: string, options: GuardOptions): ToolHooks {
    const onBlocked = options.onBlocked ?? this.onBlocked;
    const describe = describerFor(options.describe, name);

    const decideFor = (input: unknown): Promise<Decision> => {
      let descriptor: ActionDescriptor | null;
      let called: Record<string, unknown> = {};
      try {
        const args = asJson(input);
        called = isRecord(args) ? args : { value: args };
        descriptor = describeNamedTool(name, called);
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
      if (!descriptor) return Promise.resolve(invalidAction);
      // A declared input is checked here; Cloud sees classified fields as [classified].
      const fields = withContractFields(
        descriptor,
        called,
        this.options.contracts,
      );
      return "refusal" in fields
        ? Promise.resolve(contractRefused(fields.refusal))
        : this.decide(fields.action);
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
          await report(decision, isTimeout(error) ? "unknown" : "failure");
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
