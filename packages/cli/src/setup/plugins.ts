import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { ProjectSetup, SetupPlugin } from "@nodrail/policy-engine/yaml";
import type { Env } from "../config.ts";
import type { DesiredFile } from "./team-files.ts";

/**
 * A setup's plugins, as each host loads them: the project is a marketplace
 * that lists them, each from its folder, and the host's settings switch them
 * on. Claude Code loads them once the person trusts the folder. Codex lists
 * them then, and loads one once the person installs it: an install is the
 * person's, for their whole Codex, so nodrail names it and never runs it.
 */

/** Where each host reads a project's marketplace. */
export const CLAUDE_MARKETPLACE = ".claude-plugin/marketplace.json";
export const CODEX_MARKETPLACE = ".agents/plugins/marketplace.json";

/** The project's marketplace, by the team it sets up. */
export const marketplaceName = (setup: ProjectSetup) =>
  `nodrail-${setup.team?.name ?? "project"}`;

const forHost = (setup: ProjectSetup, host: "claude-code" | "codex") =>
  setup.plugins.filter((plugin) => plugin.hosts.includes(host));

const json = (value: unknown) =>
  Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

/** Claude Code's marketplace file, when there are plugins for it. */
export function claudeMarketplace(setup: ProjectSetup): DesiredFile[] {
  const plugins = forHost(setup, "claude-code");
  if (plugins.length === 0) return [];
  return [
    {
      path: CLAUDE_MARKETPLACE,
      content: json({
        name: marketplaceName(setup),
        owner: { name: "nodrail" },
        plugins: plugins.map((plugin) => ({
          name: plugin.name,
          source: `./${plugin.folder}`,
        })),
      }),
      why: `the plugins ${plugins.map((plugin) => plugin.name).join(", ")}`,
    },
  ];
}

/** Codex's marketplace file, when there are plugins for it. */
export function codexMarketplace(setup: ProjectSetup): DesiredFile[] {
  const plugins = forHost(setup, "codex");
  if (plugins.length === 0) return [];
  return [
    {
      path: CODEX_MARKETPLACE,
      content: json({
        name: marketplaceName(setup),
        plugins: plugins.map((plugin) => ({
          name: plugin.name,
          source: { source: "local", path: `./${plugin.folder}` },
          policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
          category: "Productivity",
        })),
      }),
      why: `the plugins ${plugins.map((plugin) => plugin.name).join(", ")}`,
    },
  ];
}

/** What Claude Code's settings get: the marketplace, and each plugin on. */
export function claudePluginSettings(root: string, setup: ProjectSetup) {
  const plugins = forHost(setup, "claude-code");
  if (plugins.length === 0) return { marketplaces: {}, enabled: {} };
  const name = marketplaceName(setup);
  return {
    marketplaces: {
      [name]: { source: { source: "directory", path: realpathSync(root) } },
    },
    enabled: Object.fromEntries(
      plugins.map((plugin) => [`${plugin.name}@${name}`, true]),
    ),
  };
}

/** Codex's config lines: the marketplace, and each plugin on. */
export function codexPluginLines(root: string, setup: ProjectSetup) {
  const plugins = forHost(setup, "codex");
  if (plugins.length === 0) return [];
  const name = marketplaceName(setup);
  return [
    "",
    `[marketplaces.${JSON.stringify(name)}]`,
    `source_type = "local"`,
    `source = ${JSON.stringify(realpathSync(root))}`,
    ...plugins.flatMap((plugin) => [
      "",
      `[plugins.${JSON.stringify(`${plugin.name}@${name}`)}]`,
      "enabled = true",
    ]),
  ];
}

/** Where Codex keeps an installed plugin, as `codex plugin add` leaves it. */
const installedAt = (
  env: Env,
  home: string,
  market: string,
  plugin: SetupPlugin,
) =>
  join(
    env.CODEX_HOME ?? join(home, ".codex"),
    "plugins/cache",
    market,
    plugin.name,
    plugin.versions.codex ?? "local",
  );

/**
 * Whether Codex has each plugin installed at the project's version. One it
 * hasn't isn't loaded, which doesn't stop apply: the check says so (`?`),
 * with the command, and that an install is for every folder.
 */
export function codexInstallChecks(input: {
  root: string;
  setup: ProjectSetup;
  env: Env;
  home: string;
}) {
  const market = marketplaceName(input.setup);
  return forHost(input.setup, "codex").map((plugin) => {
    const name = `plugin ${plugin.name}`;
    if (existsSync(installedAt(input.env, input.home, market, plugin)))
      return {
        name,
        ok: true,
        detail: `installed in Codex at ${plugin.versions.codex ?? "its version"}`,
      };
    return {
      name,
      ok: true,
      unverified: true,
      detail: `Codex loads it once you install it: after apply, trust the folder, then run \`codex plugin add ${plugin.name}@${market}\` there. Codex installs plugins for you, in every folder`,
    };
  });
}

/** What the person does for Claude Code to load the plugins. */
export const claudePluginNote = (setup: ProjectSetup) => {
  const plugins = forHost(setup, "claude-code");
  return plugins.length === 0
    ? []
    : [
        `Claude Code loads the plugins ${plugins.map((plugin) => plugin.name).join(", ")} from this folder once you trust it; nothing is installed.`,
      ];
};

/**
 * Each plugin copied from git: where from, at which commit. `plan` reads no
 * network, so it can't compare the folder with the commit: `?`, with the
 * command that does. What apply sets up is what the lock covers either way.
 */
export function originChecks(setup: ProjectSetup) {
  return setup.plugins.flatMap(({ name, spec }) =>
    spec.from
      ? [
          {
            name: `plugin ${name}`,
            ok: true,
            unverified: true,
            detail: `copied from ${spec.from.git} at ${spec.from.commit.slice(0, 12)}; \`nodrail plugin fetch ${name} --check\` compares it with that commit`,
          },
        ]
      : [],
  );
}
