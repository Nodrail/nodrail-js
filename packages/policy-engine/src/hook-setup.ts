import { nonEmptyText } from "./actions.ts";
import type { ConnectionCalls } from "./connections.ts";
import type { HookRun } from "./hook-command.ts";
import { readConnections } from "./hook-files.ts";
import { parseEvent } from "./local-hook.ts";
import type { Environment } from "./run-key.ts";
import {
  connectedSetup,
  dataGuard,
  setupGuard,
  withLedger,
} from "./rules-guard.ts";

export type Guards = {
  setup: ReturnType<typeof setupGuard> | null;
  connections: ConnectionCalls | null;
  data: ReturnType<typeof dataGuard> | null;
};

function unmatchedProblem(value: string | undefined) {
  if (value === undefined || value === "deny" || value === "allow") return null;
  return value === "ask"
    ? "Nodrail: --unmatched ask was removed: nothing waits for a person. Use --unmatched deny (the default), or allow to leave calls no rule covers to the host's own permissions.\n"
    : `Nodrail: --unmatched is deny or allow, not ${value}.\n`;
}

/** Keep the guards we can read available even when another guard fails. */
export function hookGuards(
  values: HookRun["values"],
  stdin: string,
  env: Environment,
  home?: string,
): { guards: Guards; error: string | null } {
  const guards: Guards = {
    setup: values.connect ? connectedSetup(values.connect, home) : null,
    connections: null,
    data: null,
  };
  let error = unmatchedProblem(values.unmatched);
  const report = (message: string, cause: unknown) => {
    error ??= `Nodrail: ${message}: ${(cause as Error).message}\n`;
  };
  try {
    if (values["protect-list"]) {
      const listed = setupGuard(values["protect-list"]);
      guards.setup = guards.setup
        ? { ...guards.setup, paths: [...guards.setup.paths, ...listed.paths] }
        : listed;
    }
  } catch (cause) {
    report("can't read the protect list", cause);
  }
  try {
    if (values.connections) {
      guards.connections = readConnections(values.connections);
      guards.data = dataGuard(values.connections, guards.connections);
    }
  } catch (cause) {
    report("can't read the connections", cause);
  }
  try {
    if (guards.setup) {
      const cwd = nonEmptyText(parseEvent(stdin)?.cwd) ?? process.cwd();
      guards.setup = withLedger(guards.setup, [cwd, guards.setup.root], env);
    }
  } catch (cause) {
    report("can't find the run ledger to protect", cause);
  }
  return { guards, error };
}
