import { z } from "zod";
import { inputParams, ruleKey, type ToolInput } from "./actions.ts";
import type { ActionDescriptor } from "./protocol.ts";

/**
 * Tool connections: MCP servers the setup declares, which the host starts
 * and every agent calls through its native tools. Claude Code and Codex
 * both name a call `mcp__<connection>__<tool>`, and both send it through the
 * policy hook first, with the subagent that made it. So the hook, not the
 * server, knows who calls: a call the policy denies never reaches it.
 */

/** A secret, by where to find it. Its value is never written anywhere. */
export const secretRef = z.union([
  z
    .object({ fromEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/) })
    .strict(),
  z
    .object({
      /** A macOS Keychain generic password, by service and account. */
      fromKeychain: z
        .object({
          service: z.string().min(1).max(200),
          account: z.string().min(1).max(200).optional(),
        })
        .strict(),
    })
    .strict(),
]);
export type SecretRef = z.infer<typeof secretRef>;

const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/);

const resourceKind = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);

/** How one operation names what it acts on, from the call's own arguments. */
export const operationSpec = z
  .object({
    resource: z
      .object({
        kind: resourceKind,
        /** The argument holding the resource's id, such as `collection`. */
        from: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/),
      })
      .strict()
      .optional(),
  })
  .strict();

/** A tool name as the server gives it, lowercase so rules can name it. */
export const toolName = z
  .string()
  .regex(/^[a-z0-9_-]{1,64}$/, "Lowercase letters, digits, - and _");

/** A file or folder in the project, `./` first: no `..`, no wildcard. */
const dataPath = z
  .string()
  .max(500)
  .regex(
    /^\.\/(?!(?:.*\/)?\.\.?(?:\/|$))(?!.*\/\/)[^*?[\]{}\\]+$/,
    "A project path such as ./memory, with no .. or wildcard",
  );

export const connectionSpec = z
  .object({
    /** The program that runs the MCP server over stdio. */
    command: z.string().min(1).max(300),
    /** Its arguments; a `./` path is a project file, locked like the rest. */
    args: z.array(z.string().max(1000)).max(50).default([]),
    /** Its environment: plain values, or secrets by reference. */
    env: z
      .record(envName, z.union([z.string().max(2000), secretRef]))
      .default({}),
    /** Every tool an agent may call; any other is refused. */
    operations: z.record(toolName, operationSpec.prefault({})),
    /**
     * What the server keeps, such as a memory file: project paths agents
     * reach only through its operations. Never locked, never removed.
     */
    data: z.array(dataPath).min(1).max(20).optional(),
  })
  .strict()
  .refine((spec) => Object.keys(spec.operations).length > 0, {
    message: "Declare at least one operation",
  })
  .refine(
    (spec) => {
      const names = Object.keys(spec.operations).map(hostName);
      return new Set(names).size === names.length;
    },
    {
      message: "Two operations differ only by - and _: Codex names them alike",
    },
  );
export type ConnectionSpec = z.infer<typeof connectionSpec>;

/** A name as Codex gives it in `mcp__<server>__<tool>`: `-` becomes `_`. */
const hostName = (name: string) => name.replaceAll("-", "_");

/**
 * The declared server a call's middle part names:
 * - `plugin_<plugin>_<server>`: Claude Code's name for a plugin's server,
 *   when that plugin declares it;
 * - `<server>`: a connection, or on Codex, which names plugin servers so, a
 *   plugin's server. Codex writes `-` as `_`; declared names have no `_`, so
 *   the one meant is never in doubt.
 */
function serverOf(
  calls: ConnectionCalls,
  given: string,
  host: "claude-code" | "codex",
) {
  const names = Object.keys(calls);
  const plugin = /^plugin_([a-z0-9-]+)_([a-z0-9_-]+)$/.exec(given);
  if (plugin) {
    const server = declaredName(names, plugin[2]!);
    return server && calls[server]!.plugin === plugin[1] ? server : undefined;
  }
  const server = declaredName(names, given);
  if (server === undefined) return undefined;
  // On Claude Code a plugin's server is never called by its bare name: one
  // that is, is another server that happens to share it.
  return calls[server]!.plugin === undefined || host === "codex"
    ? server
    : undefined;
}

/** The declared name the host's name stands for, or undefined. */
function declaredName(names: string[], given: string) {
  return names.includes(given)
    ? given
    : names.find((name) => hostName(name) === given);
}

/** The engine's own tools: a connection named so could pose as one. */
export const BUILT_IN = new Set([
  "claude-code",
  "codex",
  "files",
  "shell",
  "web",
]);

/** Connection names are MCP server names: the middle of `mcp__x__tool`. */
export const connectionsField = z.record(
  z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,62}$/)
    .refine((name) => !BUILT_IN.has(name), {
      message: "That name is one of the engine's own tools",
    }),
  connectionSpec,
);
export type Connections = z.infer<typeof connectionsField>;

/** Which connections, and which of their operations, each agent may use. */
export const agentConnectionsField = z.record(
  // An agent's name, as resourceName spells it.
  z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/),
  z
    .array(
      z.union([
        z.string().min(1).max(63),
        z
          .object({
            connection: z.string().min(1).max(63),
            operations: z.array(toolName).min(1).max(100),
          })
          .strict(),
      ]),
    )
    .max(50),
);
export type AgentConnections = z.infer<typeof agentConnectionsField>;

/** One agent's reach: each connection it may use, with the operations. */
export function exposureOf(
  agentConnections: AgentConnections,
  agent: string,
  connections: Connections,
) {
  const reach = new Map<string, Set<string>>();
  for (const entry of agentConnections[agent] ?? []) {
    const name = typeof entry === "string" ? entry : entry.connection;
    const all = Object.keys(connections[name]?.operations ?? {});
    const listed = typeof entry === "string" ? all : entry.operations;
    const earlier = reach.get(name) ?? new Set<string>();
    for (const operation of listed) earlier.add(operation);
    reach.set(name, earlier);
  }
  return reach;
}

/** What's wrong with the declared exposure, given the team's members. */
export function exposureProblems(
  agentConnections: AgentConnections,
  connections: Connections,
  members: ReadonlySet<string>,
) {
  return Object.entries(agentConnections).flatMap(([agent, entries]) => [
    ...(members.has(agent) ? [] : [`${agent} isn't on the team`]),
    ...entries.flatMap((entry) => entryProblems(agent, entry, connections)),
  ]);
}

function entryProblems(
  agent: string,
  entry: AgentConnections[string][number],
  connections: Connections,
) {
  const name = typeof entry === "string" ? entry : entry.connection;
  const connection = connections[name];
  if (!connection) return [`${agent} uses ${name}, which isn't a connection`];
  if (typeof entry === "string") return [];
  return entry.operations
    .filter((operation) => !Object.hasOwn(connection.operations, operation))
    .map((operation) => `${name} has no operation ${operation}`);
}

/** What the hook knows of each connection: its operations and resources. */
export type ConnectionCalls = Record<
  string,
  {
    operations: Record<string, { resource?: { kind: string; from: string } }>;
    /** The plugin this server comes with, when a plugin declares it. */
    plugin?: string;
    /** Its data, as project paths agents reach only through it. */
    data?: string[];
  }
>;

/** The part of the declarations the hook reads; no command, no secret. */
export const connectionCalls = (connections: Connections): ConnectionCalls =>
  Object.fromEntries(
    Object.entries(connections).map(([name, spec]) => [
      name,
      spec.data
        ? { operations: spec.operations, data: spec.data }
        : { operations: spec.operations },
    ]),
  );

export const connectionCallsFile = z.object({
  connections: z.record(
    z.string(),
    z.object({
      operations: z.record(
        z.string(),
        z.object({
          resource: z
            .object({ kind: resourceKind, from: z.string() })
            .optional(),
        }),
      ),
      plugin: z.string().optional(),
      data: z.array(dataPath).optional(),
    }),
  ),
});

/** The connections file as the hook reads it: plugin servers kept apart. */
export const hookCallsFile = connectionCallsFile.extend({
  plugins: connectionCallsFile.shape.connections.optional(),
});

const MAX_ID = 512;

/**
 * A declared connection's call, as the action it is: tool = the connection,
 * operation = the tool called, resource = what the declaration says the call
 * acts on. Null when the call isn't to a declared connection; a reason when
 * it is, but can't be read as declared, which the hook refuses.
 */
export function connectionCall(
  name: string,
  input: ToolInput,
  calls: ConnectionCalls,
  host: "claude-code" | "codex" = "claude-code",
): ActionDescriptor | string | null {
  if (!name.startsWith("mcp__")) return null;
  const [, given, ...rest] = name.split("__");
  const server = given && serverOf(calls, given, host);
  if (!server) return null;
  const operations = calls[server]!.operations;
  const tool = declaredName(Object.keys(operations), rest.join("__"));
  if (!tool)
    return `${rest.join("__")} isn't an operation connection ${server} declares`;
  const resource = operations[tool]!.resource;
  const operation = ruleKey(tool, 128);
  if (!resource)
    return {
      tool: server,
      operation,
      resource: { kind: "mcp_tool", id: `${server}.${tool}` },
      params: inputParams(input),
    };
  const id = input[resource.from];
  if (typeof id !== "string" || id.length === 0 || id.length > MAX_ID)
    return `${server} ${tool} needs ${resource.from}, the ${resource.kind} it acts on`;
  return {
    tool: server,
    operation,
    resource: { kind: resource.kind, id },
    params: inputParams(input),
  };
}

/**
 * Every word of a connection's command line that could name a project file:
 * the command, each argument, and the value of a `--flag=value`. Those that
 * start with `./` or `../` must name one; any other is a file only if the
 * project has it, like `connectors/x.mjs` (a program on PATH, a URL or a
 * flag isn't).
 */
export function connectionPaths(spec: ConnectionSpec) {
  const words = [spec.command, ...spec.args].flatMap((word) => {
    const value = word.startsWith("-")
      ? word.slice(word.indexOf("=") + 1)
      : word;
    return word.startsWith("-") && !word.includes("=") ? [] : [value];
  });
  return [...new Set(words)]
    .filter(
      (word) => word.length > 0 && !word.includes(":") && !word.startsWith("/"),
    )
    .map((word) => ({ ref: word, named: /^\.\.?\//.test(word) }));
}
