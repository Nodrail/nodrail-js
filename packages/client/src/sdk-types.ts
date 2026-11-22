// The types of the TypeScript SDK's public surface.
import type { Environment } from "./connection.ts";
import type { NodrailBlockedError } from "./sdk.ts";
import type { CallContracts } from "./contract-fields.ts";

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

export type AnyFunction = (...args: never[]) => unknown;

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
  /**
   * The run calls belong to when no `inRun` or `step` says otherwise, so gates
   * and budgets can see its history. Default: NODRAIL_RUN, else no run.
   */
  run?: string;
  /**
   * The work revision sent with a call in a run, so a gate on the revision
   * (evidence such as CI for this exact commit) can be checked. Default: the
   * git work tree at `cwd`, read at submit and again at permit. A function
   * reads it your way; null sends it as unknown, which keeps such gates
   * unmet. Never a value an agent supplies.
   */
  subject?: (() => string | null) | null;
  /** Where the default subject reads the work tree. Default: process.cwd(). */
  cwd?: string;
  /**
   * The published input contracts, by `<tool>.<operation>` (a guarded
   * tool is `<name>.call`): a guarded call is checked against its own, and
   * Cloud sees each classified argument as `[classified]`.
   */
  contracts?: CallContracts | null;
};

/** How `run` performs an action. */
export type RunOptions<T> = {
  /**
   * After this long, the call is no longer waited for and is reported as
   * `unknown`: it may still finish, so it was neither done nor not done.
   */
  timeoutMs?: number;
  /** The amounts the result measured, for budgets that sum them. */
  measure?: (result: T) => readonly { path: string; value: number }[];
};
