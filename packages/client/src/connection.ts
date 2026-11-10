import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_URL = "https://app.nodrail.com";

export type Environment = Record<string, string | undefined>;

function savedCredential(env: Environment) {
  try {
    return readFileSync(
      join(env.NODRAIL_HOME ?? join(homedir(), ".nodrail"), "credential"),
      "utf8",
    ).trim();
  } catch {
    return "";
  }
}

/**
 * Where a connection comes from, nearest first: this process, the Claude Code
 * plugin's settings, then the file a person saved once for every agent.
 */
export function resolveConnection(env: Environment) {
  return {
    url: env.NODRAIL_URL || env.CLAUDE_PLUGIN_OPTION_URL || DEFAULT_URL,
    credential:
      env.NODRAIL_CREDENTIAL ||
      env.CLAUDE_PLUGIN_OPTION_CREDENTIAL ||
      savedCredential(env) ||
      null,
  };
}

const DEFAULT_WAIT_SECONDS = 300;

/** How long to wait for a person. Unreadable values mean not waiting. */
export function waitMsFrom(env: Environment) {
  const seconds = Number(env.NODRAIL_WAIT_SECONDS ?? DEFAULT_WAIT_SECONDS);
  return Number.isFinite(seconds) ? Math.max(0, seconds) * 1000 : 0;
}
