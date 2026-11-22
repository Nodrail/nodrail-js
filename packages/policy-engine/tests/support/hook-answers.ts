// What hook tests share: a scratch git repository holding a rule file, and
// Claude Code's PreToolUse answer read back (silence is an allow).
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A fresh git repository on `branch`, with `rules` in rules.yaml. */
export function scratchRepo(rules: string, prefix: string, branch: string) {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  spawnSync("git", ["init", "-q", "-b", branch], { cwd: repo });
  const file = join(repo, "rules.yaml");
  writeFileSync(file, rules);
  return { repo, file };
}

export type Answer = {
  permissionDecision: string;
  permissionDecisionReason: string;
};

/** The hook's answer to a PreToolUse event; no output lets the call go ahead. */
export const hookAnswer = (stdout: string): Answer =>
  stdout
    ? (JSON.parse(stdout) as { hookSpecificOutput: Answer }).hookSpecificOutput
    : { permissionDecision: "allow", permissionDecisionReason: "" };
