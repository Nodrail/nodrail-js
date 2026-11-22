// How a governed call ended, as its report says: done, failed, or unknown
// when it wasn't waited for to the end and may still take effect.

/**
 * An error that says the call wasn't waited for to the end, so whether it
 * took effect is unknown: a timeout, or an abort, of the call or ours.
 */
export const isTimeout = (error: unknown) =>
  error instanceof Error &&
  (error.name === "TimeoutError" || error.name === "AbortError");

/** What `measure` reads from a result; unreadable is no reading, which a budget holds as unknown. */
export function readMeasured<T>(
  measure: ((result: T) => readonly unknown[]) | undefined,
  result: T,
): readonly unknown[] | undefined {
  try {
    return measure?.(result);
  } catch {
    return undefined;
  }
}

/** The action's result, or a TimeoutError once `timeoutMs` passes. */
export async function withinTime<T>(
  action: () => T | Promise<T>,
  timeoutMs: number | undefined,
): Promise<T> {
  if (timeoutMs === undefined) return action();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new DOMException(
            `Nodrail: the call took longer than ${timeoutMs} ms; its outcome is unknown.`,
            "TimeoutError",
          ),
        ),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([Promise.resolve().then(action), late]);
  } finally {
    clearTimeout(timer);
  }
}
