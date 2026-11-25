import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Env } from "../config.ts";

const read = (file: string) => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
};

const plugin = "nodrail@nodrail";
const settings = z.object({
  enabledPlugins: z.record(z.string(), z.boolean()).optional(),
  hooks: z
    .record(
      z.string(),
      z.array(
        z.object({
          hooks: z.array(z.object({ command: z.string().optional() })),
        }),
      ),
    )
    .optional(),
});

function legacyClaude(file: string) {
  try {
    const parsed = settings.safeParse(JSON.parse(read(file)));
    if (!parsed.success) return false;
    const { enabledPlugins, hooks } = parsed.data;
    return (
      enabledPlugins?.[plugin] === true ||
      Object.values(hooks ?? {}).some((groups) =>
        groups.some((group) =>
          group.hooks.some(({ command }) =>
            command?.startsWith("nodrail connect hook "),
          ),
        ),
      )
    );
  } catch {
    return false;
  }
}

export const LEGACY_HINT =
  "Legacy Nodrail setup detected. See the connect: migration at https://nodrail.com/docs/cli#upgrade-to-connect";

export function hasLegacySetup(root: string, home: string, env: Env) {
  const claude = env.CLAUDE_CONFIG_DIR ?? join(home, ".claude");
  const codex = env.CODEX_HOME ?? join(home, ".codex");
  const codexConfig = read(join(codex, "config.toml"));
  const legacyPlugin = /^\s*\[plugins\.["']nodrail@nodrail["']\]\s*(?:#.*)?$/m;
  const token = /^ndr_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/;
  return (
    legacyClaude(join(root, ".claude/settings.json")) ||
    legacyClaude(join(claude, "settings.json")) ||
    legacyPlugin.test(codexConfig) ||
    token.test(
      read(
        join(env.NODRAIL_HOME ?? join(home, ".nodrail"), "credential"),
      ).trim(),
    ) ||
    token.test(env.CLAUDE_PLUGIN_OPTION_CREDENTIAL ?? "")
  );
}
