import type { Io } from "../io.ts";
import { EFFECTIVE_FILE, SETTINGS_FILE, isPolicyHook } from "./claude-code.ts";
import { CODEX_HOOKS, codexHooks, hookActivation } from "./codex.ts";
import { CONNECT_FILE } from "./connect.ts";
import { copilotActivation } from "./copilot.ts";
import { preToolCommands } from "./hook-settings.ts";
import { launcherTail } from "./launcher.ts";
import { findOnPath, type SetupPlan } from "./plan.ts";
import { claudeActivation, type Activation } from "./status.ts";

/**
 * Whether the host runs nodrail's hook here. Codex is asked: it runs a
 * project's hooks only once the person trusts the folder and the hook.
 * Claude Code can't be asked; its settings are read for what turns hooks off.
 */
export async function activation(
  plan: SetupPlan,
  root: string,
  io: Io,
): Promise<Activation> {
  if (plan.runtime === "claude-code") {
    if (!preToolCommands(root, SETTINGS_FILE).some(isPolicyHook))
      return {
        state: "inactive",
        detail:
          "the policy hook is missing from .claude/settings.json; run nodrail apply",
      };
    return claudeActivation({ root, home: io.home, env: io.env });
  }
  if (plan.runtime === "copilot")
    return copilotActivation({ root, home: io.home, env: io.env });
  const command = preToolCommands(root, CODEX_HOOKS).find(
    (value) =>
      launcherTail(value).startsWith("policy hook ") &&
      value.includes("--host codex"),
  );
  if (!command)
    return {
      state: "inactive",
      detail:
        "the policy hook is missing from .codex/hooks.json; run nodrail apply",
    };
  const codex = findOnPath("codex", io.env);
  if (codex === null)
    return { state: "unknown", detail: "codex isn't on PATH to ask" };
  const hooks = await codexHooks(codex, root, io.env);
  return typeof hooks === "string"
    ? { state: "unknown", detail: hooks }
    : hookActivation(hooks, command);
}

export const policyRevisionPending = (plan: SetupPlan) =>
  plan.steps.some(
    ({ path, action }) =>
      [EFFECTIVE_FILE, CONNECT_FILE].includes(path) && action !== "keep",
  );
