// The policy hook must never fail open. Claude Code runs the tool when a hook
// crashes or outlasts its time limit (observed with 2.1.330; `onFailure:
// "block"` covers only the hooks a setup marks with it), and Copilot runs it
// on a time-out. So while the hook works, an error nothing caught and a
// deadline under the hosts' limits both end it with exit 2, which blocks a
// tool call on every host. A step event (a subagent starting or stopping)
// ends with 0 instead: exit 2 there would keep the subagent from stopping,
// and a step that isn't recorded already keeps its gates closed.

/** Under Copilot's 20 s (the shortest limit a setup gives) and Claude Code's 60 s default. */
export const HOOK_DEADLINE_MS = 15_000;

/** What failing means for the event in hand: blocked (2) until it is known to be a step. */
const current = { failure: 2 };

/** The event read is a step's, not a tool call's. */
export function hookIsStep() {
  current.failure = 0;
}

/** The exit code a failure of the hook ends with now. */
export const hookFailure = () => current.failure;

type Report = (text: string) => void;
type Exit = (code: number) => void;

/**
 * Runs the hook with an exit for whatever it doesn't handle: an uncaught
 * error, a rejected promise, or the deadline passing while it waits.
 * Everything is removed again when the hook returns.
 */
export async function guardHook(
  work: () => Promise<number>,
  report: Report,
  exit: Exit = (code) => process.exit(code),
  deadline = HOOK_DEADLINE_MS,
): Promise<number> {
  current.failure = 2;
  const fail = (why: string) => {
    report(
      current.failure
        ? `Nodrail: the hook ${why}, so this action is blocked.\n`
        : `Nodrail: the hook ${why}; the step isn't recorded.\n`,
    );
    exit(current.failure);
  };
  const crashed = () => fail("failed");
  const timer = setTimeout(
    () => fail(`took longer than ${deadline / 1000} s`),
    deadline,
  );
  timer.unref();
  process.on("uncaughtException", crashed);
  process.on("unhandledRejection", crashed);
  try {
    return await work();
  } finally {
    clearTimeout(timer);
    process.off("uncaughtException", crashed);
    process.off("unhandledRejection", crashed);
  }
}
