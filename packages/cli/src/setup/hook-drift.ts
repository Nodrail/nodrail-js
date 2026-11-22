// Which of the policy hook's events in Claude Code's settings are gone or
// narrowed since apply: the call hook always, the step and outcome hooks
// when the applied policy needs them.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SETTLE_EVENTS,
  STEP_EVENTS,
  usesLimits,
  usesRuns,
} from "./claude-code.ts";
import { EFFECTIVE_FILE } from "./team-files.ts";

/** A matcher that covers every tool, as apply writes it. */
const everyTool = (matcher: string | null) =>
  matcher === null || matcher === "" || matcher === "*" || matcher === ".*";

/**
 * Each event apply hooks the policy to, as the applied policy needs it, that
 * no longer has it, or only for some tools: [event, what is wrong].
 */
export function missingHooks(
  root: string,
  hooks: { event: string; matcher: string | null }[],
): [string, string][] {
  let effective = "";
  try {
    effective = readFileSync(join(root, EFFECTIVE_FILE), "utf8");
  } catch {
    // Without the applied policy, only the call hook is known to be needed.
  }
  const wanted: [string, boolean][] = [
    ["PreToolUse", true],
    ...(effective && usesRuns(effective)
      ? STEP_EVENTS.map((event): [string, boolean] => [event, false])
      : []),
    ...(effective && usesLimits(effective)
      ? SETTLE_EVENTS.map((event): [string, boolean] => [event, true])
      : []),
  ];
  return wanted.flatMap(([event, matched]): [string, string][] => {
    const found = hooks.filter((hook) => hook.event === event);
    if (found.length === 0) return [[event, "is gone"]];
    if (matched && !found.some((hook) => everyTool(hook.matcher)))
      return [
        [event, `only matches ${found.map((h) => h.matcher).join(", ")}`],
      ];
    return [];
  });
}
