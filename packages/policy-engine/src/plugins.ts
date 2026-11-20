import { z } from "zod";
import {
  BUILT_IN,
  operationSpec,
  toolName,
  type ConnectionCalls,
} from "./connections.ts";

/**
 * Plugins a setup ships with: a folder in the project that each host loads
 * as a plugin, with the MCP servers it brings and the operations agents may
 * call on each. Claude Code loads it once the folder is trusted; Codex once
 * the person installs it. The hook reads its servers' calls as it reads a
 * connection's, by the server's name, so one rule names them on both hosts.
 */

const name = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "Lowercase letters, digits and -");

const serverSpec = z
  .object({
    /** Every tool an agent may call; any other is refused. */
    operations: z.record(toolName, operationSpec.prefault({})),
  })
  .strict()
  .refine((spec) => Object.keys(spec.operations).length > 0, {
    message: "Declare at least one operation",
  });

/** A git repository at one commit: never a branch or tag, which can move. */
export const pluginOrigin = z
  .object({
    git: z
      .string()
      .max(500)
      .regex(
        /^(?:https:\/\/|ssh:\/\/|git@|file:\/\/)[^\s]+$/,
        "An https://, ssh:// or git@ address",
      ),
    commit: z
      .string()
      .regex(
        /^[0-9a-f]{40}$/,
        "A full commit id, 40 hex characters: a branch or tag can move",
      ),
    /** The plugin's folder in the repository; its top when left out. */
    path: z
      .string()
      .max(300)
      .regex(
        /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._/-]+$/,
        "A folder in the repository, such as plugins/desk-kit",
      )
      .optional(),
  })
  .strict();
export type PluginOrigin = z.infer<typeof pluginOrigin>;

export const pluginSpec = z
  .object({
    /** The plugin's folder in the project, locked like the rest. */
    source: z
      .string()
      .max(300)
      .regex(
        /^\.\/[A-Za-z0-9._/-]*$/,
        "A folder in the project, starting with ./",
      ),
    /** Its MCP servers, by the name its manifests give them. */
    servers: z.record(name, serverSpec).default({}),
    /**
     * Where its files come from, when it's someone else's: a git repository
     * at one commit, and the folder in it. `nodrail plugin fetch` copies
     * them into `source`, where the lock covers them like your own files.
     */
    from: pluginOrigin.optional(),
  })
  .strict();
export type PluginSpec = z.infer<typeof pluginSpec>;

export const pluginsField = z.record(
  name.refine((value) => !BUILT_IN.has(value), {
    message: "That name is one of the engine's own tools",
  }),
  pluginSpec,
);
export type Plugins = z.infer<typeof pluginsField>;

/** Which plugins each agent may use; without it, every member may. */
export const agentPluginsField = z.record(
  z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/),
  z.array(name).max(50),
);
export type AgentPlugins = z.infer<typeof agentPluginsField>;

/**
 * What's wrong with the plugins' server names: each must be unique among
 * plugins and connections, since Codex calls a plugin's server by its name
 * alone, as it calls a connection.
 */
export function serverClashes(
  plugins: Plugins,
  connections: readonly string[],
) {
  const seen = new Map<string, string>(
    connections.map((connection) => [connection, `connection ${connection}`]),
  );
  const problems: string[] = [];
  for (const [plugin, spec] of Object.entries(plugins))
    for (const server of Object.keys(spec.servers)) {
      if (BUILT_IN.has(server))
        problems.push(
          `${plugin}'s server ${server} is named like one of the engine's own tools`,
        );
      const earlier = seen.get(server);
      if (earlier)
        problems.push(
          `${plugin}'s server ${server} has the name of ${earlier}: Codex couldn't tell their calls apart`,
        );
      seen.set(server, `plugin ${plugin}'s server`);
    }
  return problems;
}

/** What's wrong with `agentPlugins`, given the team and the plugins. */
export function agentPluginProblems(
  agentPlugins: AgentPlugins,
  plugins: Plugins,
  members: ReadonlySet<string>,
) {
  return Object.entries(agentPlugins).flatMap(([agent, names]) => [
    ...(members.has(agent) ? [] : [`${agent} isn't on the team`]),
    ...names.flatMap((plugin) =>
      Object.hasOwn(plugins, plugin)
        ? []
        : [`${agent} uses ${plugin}, which isn't a plugin`],
    ),
  ]);
}

/** The plugins an agent may use. */
export const pluginsOf = (
  agentPlugins: AgentPlugins | null,
  agent: string,
  plugins: Plugins,
) =>
  new Set(
    agentPlugins === null ? Object.keys(plugins) : (agentPlugins[agent] ?? []),
  );

/** What the hook knows of each plugin's servers, keyed by server name. */
export const pluginCalls = (plugins: Plugins): ConnectionCalls =>
  Object.fromEntries(
    Object.entries(plugins).flatMap(([plugin, spec]) =>
      Object.entries(spec.servers).map(([server, { operations }]) => [
        server,
        { operations, plugin },
      ]),
    ),
  );
