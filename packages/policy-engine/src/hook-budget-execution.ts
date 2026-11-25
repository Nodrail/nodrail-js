import { deny, type HookResult } from "./actions.ts";
import type { SharedBudgetClaim } from "./budget-claims.ts";
import { copilotAnswer, copilotRefusal } from "./copilot-hook.ts";
import type { DecisionSink } from "./decision-report.ts";
import { hookBudgetAuthority } from "./hook-budgets.ts";
import type { LocalHookOptions } from "./local-hook.ts";
import type { Environment } from "./run-key.ts";

export function budgetExecution(
  sink: DecisionSink | null,
  config: {
    env: Environment;
    policyDigest: string | null;
    fetch?: typeof fetch;
  },
) {
  const claims: SharedBudgetClaim[] = [];
  return {
    async prepare(event: string, options: LocalHookOptions) {
      const budgets =
        sink &&
        (await hookBudgetAuthority(
          event,
          options,
          {
            ...config,
            destination: sink.destination,
            onClaim: (claim) => claims.push(claim),
          },
          config.fetch,
        ));
      return { ...options, budgets: budgets || undefined };
    },
    finish(result: HookResult, copilot = false): HookResult {
      if (!claims.length) return result;
      const reject = copilot ? copilotRefusal : deny;
      const denied =
        result.exitCode !== 0 ||
        (copilot
          ? Boolean(result.stdout)
          : Boolean(copilotAnswer([result]).stdout));
      if (denied) {
        sink?.cancel(claims);
        return result;
      }

      let forget: () => void;
      try {
        if (!sink) throw new Error("No outcome sink");
        forget = sink.remember(claims);
      } catch {
        sink?.cancel(claims);
        return reject(
          "Nodrail: the shared budget claims could not be recorded.",
        );
      }
      if (
        claims.every(
          ({ expiresAt, expiresTick }) =>
            Date.now() < expiresAt && performance.now() < expiresTick,
        )
      )
        return result;
      sink.cancel(claims);
      forget();
      return reject(
        "Nodrail: the shared budget lease expired before execution.",
      );
    },
  };
}
