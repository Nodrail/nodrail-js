/** One step of a run: the agent that worked, and the verdict it reported. */
export type Step = readonly [agent: string, verdict?: string];

/**
 * The events a run ledger holds for these steps, in order, as the hook
 * records them: each step started, then finished with its verdict.
 */
export function stepEvents(steps: readonly Step[], at: string) {
  return steps.flatMap(([agent, verdict], index) => [
    { type: "step.started", agent, step: `s${index}`, at },
    {
      type: "step.finished",
      agent,
      step: `s${index}`,
      at,
      verdict: verdict ?? "done",
      findings: [],
      usage: {},
    },
  ]);
}
