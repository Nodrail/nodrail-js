import { homedir } from "node:os";
import { callKey } from "./decision-report.ts";
import { enqueue, spoolFolder } from "./telemetry.ts";

function readEvent(stdin: string) {
  try {
    return JSON.parse(stdin) as Record<string, unknown> | null;
  } catch {
    return null;
  }
}

/** Record why watch could not evaluate, even when the server is unavailable. */
export function recordWatchFailure(input: {
  file: string;
  home?: string;
  host: string;
  stdin: string;
  now: Date;
  reason: string;
  warn: (text: string) => void;
}) {
  try {
    const event = readEvent(input.stdin);
    const folder = spoolFolder(
      input.home ?? homedir(),
      input.file,
      "watch-audit",
    );
    enqueue(folder, {
      type: "evaluation_failure",
      at: input.now.toISOString(),
      host: input.host,
      call: callKey(input.host, {
        session_id: event?.session_id ?? event?.sessionId,
        tool_use_id: event?.tool_use_id ?? event?.toolCallId,
      }),
      reason: input.reason.trim(),
    });
  } catch (error) {
    input.warn(`Nodrail: watch audit failed: ${(error as Error).message}\n`);
  }
}
