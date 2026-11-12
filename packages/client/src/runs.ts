// Runs and steps for any agent framework. A step is a function call: the
// agent's work. Every guarded call made while it runs belongs to it, carried
// by AsyncLocalStorage, so tool code needs no change to be counted.
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { agentName, receiptBlock } from "@nodrail/policy-engine/hook-runs";
import type { NodrailClient, RunRef, StepReceipt } from "./index.ts";

type Scope = { key: string; step?: { id: string; agent: string } };

/** What a step's result says, when it is a receipt or carries one. */
export type ReadReceipt<T> = (result: T) => StepReceipt | null;

export type StepOptions<T> = {
  /** How to read the receipt from the result. By default, see `receiptOf`. */
  receipt?: ReadReceipt<T>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The default reading: a string ending with a `nodrail-receipt` block, or an
 * object with a `verdict`, as an agent framework's final output often is.
 */
export function receiptOf(result: unknown): StepReceipt | null {
  if (typeof result === "string") {
    const text = receiptBlock(result);
    return text ? { text } : null;
  }
  if (isRecord(result) && typeof result.verdict === "string") {
    const words = (value: unknown) =>
      Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : [];
    const usage = isRecord(result.usage) ? result.usage : {};
    const number = (value: unknown) =>
      typeof value === "number" && Number.isFinite(value) && value >= 0
        ? value
        : undefined;
    const tokens = number(usage.tokens);
    const usd = number(usage.usd);
    return {
      verdict: result.verdict,
      findings: words(result.findings),
      usage: {
        ...(tokens === undefined ? {} : { tokens }),
        ...(usd === undefined ? {} : { usd }),
      },
    };
  }
  return null;
}

export class Runs {
  private readonly scope = new AsyncLocalStorage<Scope>();

  constructor(
    private readonly client: () => NodrailClient | null,
    private readonly defaultKey: string | undefined,
  ) {}

  /** The run and step a call made here belongs to, if any. */
  current(): RunRef | undefined {
    const scope = this.scope.getStore();
    if (scope) return scope;
    return this.defaultKey ? { key: this.defaultKey } : undefined;
  }

  /** Runs `work` as part of the run `key`; steps and calls inside belong to it. */
  inRun<T>(key: string, work: () => T): T {
    const trimmed = key.trim();
    if (!trimmed) throw new TypeError("Nodrail: a run needs a key.");
    return this.scope.run({ key: trimmed.slice(0, 200) }, work);
  }

  /**
   * Records `agent` starting, runs `work` as that step, and records it
   * finishing with the receipt read from its result. A step that throws
   * finishes with no verdict, so a gate waiting for it stays closed.
   * Recording never stops the work: a lost record only leaves a gate closed.
   */
  async step<T>(
    agent: string,
    work: () => T | Promise<T>,
    options: StepOptions<T> = {},
  ): Promise<T> {
    const run = this.current();
    if (!run)
      throw new TypeError(
        "Nodrail: a step needs a run. Pass `run` to new Nodrail(), set NODRAIL_RUN, or call inside nodrail.inRun().",
      );
    const step = { id: randomUUID(), agent: agentName(agent) };
    const ref = { key: run.key };
    await this.send({ run: ref, step, event: "started" });
    let result: T;
    try {
      result = await this.scope.run({ key: run.key, step }, work);
    } catch (error) {
      await this.send({ run: ref, step, event: "finished" });
      throw error;
    }
    const receipt = (options.receipt ?? receiptOf)(result);
    await this.send({
      run: ref,
      step,
      event: "finished",
      ...(receipt ? { receipt } : {}),
    });
    return result;
  }

  private async send(event: Parameters<NodrailClient["step"]>[0]) {
    await this.client()
      ?.step(event)
      .catch(() => undefined);
  }
}
