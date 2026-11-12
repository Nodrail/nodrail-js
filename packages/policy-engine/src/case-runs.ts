// A run's history as a cases file writes it, short enough to read:
//
//   run:
//     - { started: dev }
//     - { finished: dev, verdict: done }
//     - { finished: qa, verdict: pass, usd: 0.5 }
//     - { action: dev }
//     - { action: main, command: git status }
//   step: dev        # the step taking the action, if any
import { z } from "zod";
import { describeToolCall } from "./actions.ts";
import { isChange } from "./changes.ts";
import { agentName, type RunContext, type RunEvent } from "./runs.ts";

const at = "2026-01-01T00:00:00.000Z";
const word = z.string().min(1).max(63);

const shortEvent = z.union([
  z.strictObject({ started: word }),
  z.strictObject({
    finished: word,
    verdict: z.string().nullable().optional(),
    findings: z.array(z.string()).optional(),
    tokens: z.number().nonnegative().optional(),
    usd: z.number().nonnegative().optional(),
  }),
  z.strictObject({ action: word, command: z.string().min(1).optional() }),
]);

type ShortEvent = z.infer<typeof shortEvent>;

/** An action is a change unless its command only looks around. */
function changes(command: string | undefined) {
  if (command === undefined) return true;
  const action = describeToolCall("Bash", { command });
  return action ? isChange(action) : true;
}

export const caseRun = {
  run: z.array(shortEvent).max(1000).optional(),
  step: word.optional(),
};

/**
 * Each agent's steps are numbered in order, and an action belongs to the
 * agent's open step, or to its last one. A finish with no open step is a whole
 * step: it starts and finishes there.
 */
export function toRunContext(
  run: ShortEvent[] | undefined,
  step: string | undefined,
): RunContext | null {
  if (!run && !step) return null;
  const open = new Map<string, string>();
  let count = 0;
  const events = (run ?? []).flatMap((item): RunEvent[] => {
    if ("started" in item) {
      const agent = agentName(item.started);
      const id = `${agent}-${++count}`;
      open.set(agent, id);
      return [{ type: "step.started", step: id, agent, at }];
    }
    if ("finished" in item) {
      const agent = agentName(item.finished);
      const openStep = open.get(agent);
      const id = openStep ?? `${agent}-${++count}`;
      open.delete(agent);
      const start: RunEvent[] = openStep
        ? []
        : [{ type: "step.started", step: id, agent, at }];
      return [
        ...start,
        {
          type: "step.finished",
          step: id,
          agent,
          at,
          verdict: item.verdict ? item.verdict.trim().toLowerCase() : null,
          findings: (item.findings ?? []).map((text) => text.toLowerCase()),
          usage: {
            ...(item.tokens === undefined ? {} : { tokens: item.tokens }),
            ...(item.usd === undefined ? {} : { usd: item.usd }),
          },
        },
      ];
    }
    const agent = agentName(item.action);
    return [
      {
        type: "action",
        step: open.get(agent) ?? null,
        agent,
        at,
        tool: "shell",
        operation: "command.run",
        outcome: "allow",
        change: changes(item.command),
      },
    ];
  });
  const current = step ? agentName(step) : null;
  return {
    run: "test",
    step: current
      ? { id: open.get(current) ?? `${current}-current`, agent: current }
      : null,
    events,
  };
}
