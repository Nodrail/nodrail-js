import { runHook, type AgentKind } from "./hooks.ts";

/**
 * Exit 2 is what blocks a tool in both agents. Any other failure lets it run
 * unless Claude Code is configured with onFailure: "block", and Codex has no such
 * setting, so nothing here may end in an ordinary crash: not a rejected
 * promise, and not an error thrown later in a callback either. Only a tool
 * call is blocked; for any other event (a step, a session start, a report)
 * exit 2 would keep a subagent from stopping, so a failure there ends with 0.
 */
let failure = 2;

const fail = () => {
  process.stderr.write(
    failure
      ? "Nodrail: the hook failed, so this action is blocked.\n"
      : "Nodrail: the hook failed; nothing was recorded.\n",
  );
  process.exit(failure);
};

process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);

/** Whether the event is a tool call about to run, the one thing a failure blocks. */
function isToolCall(stdin: string) {
  try {
    return (
      (JSON.parse(stdin) as { hook_event_name?: unknown }).hook_event_name ===
      "PreToolUse"
    );
  } catch {
    return true;
  }
}

async function main() {
  const agent: AgentKind =
    process.argv[2] === "codex" ? "codex" : "claude-code";
  let stdin = "";
  for await (const chunk of process.stdin) stdin += String(chunk);
  if (!isToolCall(stdin)) failure = 0;
  const result = await runHook(stdin, process.env, { agent });
  if (result.stderr) process.stderr.write(result.stderr);
  // The answer is written in full before the process ends.
  if (result.stdout)
    process.stdout.write(result.stdout, () => process.exit(result.exitCode));
  else process.exit(result.exitCode);
}

main().catch(fail);
