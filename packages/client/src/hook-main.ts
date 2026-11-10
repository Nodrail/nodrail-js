import { runHook, type AgentKind } from "./hooks.ts";

/**
 * Exit 2 is what blocks a tool in both agents. Any other failure lets it run
 * unless Claude Code is configured with onFailure: "block", and Codex has no such
 * setting, so nothing here may end in an ordinary crash.
 */
async function main() {
  const agent: AgentKind =
    process.argv[2] === "codex" ? "codex" : "claude-code";
  let stdin = "";
  for await (const chunk of process.stdin) stdin += String(chunk);
  const result = await runHook(stdin, process.env, { agent });
  if (result.stderr) process.stderr.write(result.stderr);
  // A request still waiting for a person must not hold the answer back.
  if (result.stdout)
    process.stdout.write(result.stdout, () => process.exit(result.exitCode));
  else process.exit(result.exitCode);
}

main().catch(() => {
  process.stderr.write(
    "Nodrail: the hook failed, so this action is blocked.\n",
  );
  process.exit(2);
});
