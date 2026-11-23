import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { pluginCalls } from "@nodrail/policy-engine/yaml";
import type {
  ConnectionSpec,
  ProjectSetup,
  SecretRef,
  SetupConnection,
} from "@nodrail/policy-engine/yaml";
import {
  hasSecret,
  readStatus,
  secretName,
  secretValue,
  spoolFolder,
} from "@nodrail/policy-engine/command-line";
import type { Env } from "../config.ts";
import type { CompiledContracts } from "../contracts/engine.ts";
import { askServer } from "./json-lines.ts";
import type { DesiredFile } from "./team-files.ts";
import { basename, join, resolve } from "node:path";

/**
 * Where apply writes the declared connections: what the hook reads to judge
 * a call, and what `nodrail connection run` starts. It holds references to
 * secrets, never a secret.
 */
export const CONNECTIONS_FILE = ".nodrail/connections.json";

/** Where apply writes the telemetry settings, for the hook's sender. */
export const TELEMETRY_FILE = ".nodrail/telemetry.json";

/** The telemetry settings, with references to secrets, never a secret. */
export function telemetrySettings(
  root: string,
  setup: ProjectSetup,
): DesiredFile | null {
  if (!setup.telemetry) return null;
  const settings = {
    project: basename(root),
    ...(setup.id ? { projectId: setup.id } : {}),
    traces: setup.telemetry.traces,
  };
  return {
    path: TELEMETRY_FILE,
    content: Buffer.from(`${JSON.stringify(settings, null, 2)}\n`),
    why: `send each decision to ${setup.telemetry.traces.endpoint}`,
  };
}

/**
 * How sending decisions went, from what the sender last recorded: a note,
 * as a receiver that is down never stops a decision or the setup.
 */
export function telemetryNote(
  home: string,
  root: string,
  setup: Pick<ProjectSetup, "telemetry" | "id">,
) {
  if (!setup.telemetry) return null;
  const to = setup.telemetry.traces.endpoint;
  const unbound = setup.id
    ? ""
    : ` Reports name this project by its folder only: add \`id: ${randomUUID()}\` to nodrail.yaml and commit it, so a clone or a rename stays the same project.`;
  const status = readStatus(spoolFolder(home, join(root, TELEMETRY_FILE)));
  if (!status)
    return `Telemetry: each decision goes to ${to}; none sent yet.${unbound}`;
  const lost = [
    status.rejected ? `${status.rejected} refused by the receiver` : "",
    status.unknown ? `${status.unknown} with no readable answer` : "",
    status.dropped > 0 ? `${status.dropped} dropped` : "",
  ].filter(Boolean);
  const losses = lost.length > 0 ? `; ${lost.join(", ")}` : "";
  const why = status.lastRejection ? ` (${status.lastRejection})` : "";
  return status.error
    ? `Telemetry is degraded: ${status.error} at ${status.at}${losses}${why}. Decisions go on as before; spans wait, up to a limit.${unbound}`
    : `Telemetry: ${status.sent} kept by ${to}${losses}${why}; last at ${status.at}.${unbound}`;
}

/**
 * The hook's flags for the setup's connections and telemetry, if any. The
 * connected hook takes no telemetry: Nodrail records each decision itself.
 */
export function hookReads(
  setup: ProjectSetup,
  path: (file: string) => string,
  options: { telemetry?: boolean } = {},
) {
  return [
    ...(setup.connections.length > 0 || pluginServers(setup)
      ? [`--connections ${path(CONNECTIONS_FILE)}`]
      : []),
    ...(setup.telemetry && options.telemetry !== false
      ? [`--telemetry ${path(TELEMETRY_FILE)}`]
      : []),
  ]
    .map((flag) => ` ${flag}`)
    .join("");
}

/** The arguments a host starts a connection with: nodrail runs it. */
export const runnerArgs = (file: string, name: string) => [
  "connection",
  "run",
  file,
  name,
];

export function connectionsFile(
  setup: ProjectSetup,
  contracts: CompiledContracts | null = null,
): DesiredFile | null {
  if (setup.connections.length === 0 && !pluginServers(setup)) return null;
  const connections = Object.fromEntries(
    setup.connections.map((each) => [each.name, each.spec]),
  );
  // Plugin servers apart: the host starts them, so only the hook reads them.
  const plugins = pluginCalls(
    Object.fromEntries(setup.plugins.map((each) => [each.name, each.spec])),
  );
  const mediated = mediatedContracts(
    setup.connections.map((each) => each.name),
    contracts,
  );
  return {
    path: CONNECTIONS_FILE,
    content: Buffer.from(
      `${JSON.stringify(
        {
          connections,
          ...(Object.keys(plugins).length > 0 ? { plugins } : {}),
          ...(mediated ? { contracts: mediated } : {}),
        },
        null,
        2,
      )}\n`,
    ),
    why: "the tool connections, for the hook and to start them",
  };
}

/**
 * What each connection with a declared `input` or `output` is checked
 * against, as `nodrail connection run` reads it: its bindings and their
 * compiled shapes, pinned by digest, in the file apply writes. Null when no
 * connection declares one, so that file stays as it was.
 */
export function mediatedContracts(
  names: string[],
  contracts: CompiledContracts | null,
): Record<string, ConnectionContracts> | null {
  const found: Record<string, ConnectionContracts> = {};
  for (const name of names) {
    const bindings = (contracts?.bindings ?? []).filter(
      (b) =>
        (b.surface === "S03" || b.surface === "S04") &&
        b.shape !== null &&
        b.name.slice(b.name.indexOf(":") + 1).startsWith(`${name}.`),
    );
    if (bindings.length === 0) continue;
    found[name] = {
      bindings: bindings.map(({ name: binding, surface, shape }) => ({
        name: binding,
        surface,
        shape,
      })),
      shapes: Object.fromEntries(
        bindings.map((b) => [b.shape!, contracts!.shapes[b.shape!]!]),
      ),
    };
  }
  return Object.keys(found).length > 0 ? found : null;
}

/** A connection's slice of the compiled contracts: enough to mediate it. */
export type ConnectionContracts = {
  bindings: { name: string; surface: string; shape: string | null }[];
  shapes: Record<string, CompiledContracts["shapes"][string]>;
};

/** Whether a plugin brings a server whose calls the hook must read. */
const pluginServers = (setup: Partial<Pick<ProjectSetup, "plugins">>) =>
  (setup.plugins ?? []).some(
    (plugin) => Object.keys(plugin.spec.servers).length > 0,
  );

/** The names a host must pass through for `fromEnv` secrets to reach it. */
export const envNames = (spec: ConnectionSpec) =>
  Object.values(spec.env).flatMap((value) =>
    typeof value === "object" && "fromEnv" in value ? [value.fromEnv] : [],
  );

/** What every process needs to run at all; nothing else is inherited. */
const BASE = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "SHELL",
  "SystemRoot",
  "PATHEXT",
  "TEMP",
  "TMP",
  "APPDATA",
  "LOCALAPPDATA",
  "USERPROFILE",
];

/** A plain value naming a project path, such as `./memory/desk.jsonl`. */
export const projectPath = (value: string) => value.startsWith("./");

/**
 * A connection's environment: the few variables every program needs, its
 * plain values, and its secrets read now. The rest of the host's
 * environment, other secrets included, stays out. A `./` value is a path in
 * the project, given whole: a server may resolve a relative path against
 * its own install folder, not the folder it runs in.
 */
export function connectionEnv(spec: ConnectionSpec, env: Env, root: string) {
  const result: Record<string, string> = {};
  for (const name of BASE)
    if (env[name] !== undefined) result[name] = env[name]!;
  for (const [name, value] of Object.entries(spec.env))
    result[name] =
      typeof value !== "string"
        ? secretValue(value, env)
        : projectPath(value)
          ? resolve(root, value)
          : value;
  return result;
}

/** A check line, as plan shows them. */
export type ConnectionCheck = { name: string; ok: boolean; detail: string };

/**
 * Each secret the setup names: who gets it (a connection, or the telemetry
 * sender for its headers), and whether it is there.
 */
export function secretChecks(
  setup: Pick<ProjectSetup, "connections" | "telemetry">,
  env: Env,
): ConnectionCheck[] {
  const users = new Map<string, { ref: SecretRef; names: string[] }>();
  const add = (value: string | SecretRef, receiver: string) => {
    if (typeof value === "string") return;
    const key = secretName(value);
    const entry = users.get(key) ?? { ref: value, names: [] };
    entry.names.push(receiver);
    users.set(key, entry);
  };
  for (const { name, spec } of setup.connections)
    for (const value of Object.values(spec.env))
      add(value, `connection ${name}`);
  for (const value of Object.values(setup.telemetry?.traces.headers ?? {}))
    add(value, "the telemetry sender");
  if (setup.telemetry?.traces.bearer)
    add(setup.telemetry.traces.bearer, "the telemetry sender");
  return [...users].map(([key, { ref, names }]) => {
    const who = names.join(", ");
    return hasSecret(ref, env)
      ? { name: `secret ${key}`, ok: true, detail: `set; given only to ${who}` }
      : {
          name: `secret ${key}`,
          ok: false,
          detail: `missing; ${who} needs it`,
        };
  });
}

/**
 * What a connection runs, as plan shows it before anything starts: its
 * command line, and its environment by name, secrets marked.
 */
export function connectionLine({ name, spec }: SetupConnection) {
  const word = (text: string) =>
    /^[A-Za-z0-9._/:=@%+,-]+$/.test(text) ? text : JSON.stringify(text);
  const env = Object.entries(spec.env).map(([key, value]) =>
    typeof value !== "string"
      ? `${key} (secret ${secretName(value)})`
      : projectPath(value)
        ? `${key}=${value}`
        : key,
  );
  const data = spec.data
    ? `; keeps ${spec.data.join(", ")}, which agents reach only through it`
    : "";
  return `${name}: runs ${[spec.command, ...spec.args].map(word).join(" ")}${env.length > 0 ? `; with ${env.join(", ")}` : ""}${data}`;
}

/** Programs that fetch the package they run, and how each pins a version. */
const RUNNERS: Record<string, { pinned: RegExp; example: string }> = {
  npx: {
    pinned: /^(?:@[^/@]+\/)?[^@]+@\d+\.\d+\.\d+(?:-[\w.]+)?$/,
    example: "<package>@1.2.3",
  },
  bunx: {
    pinned: /^(?:@[^/@]+\/)?[^@]+@\d+\.\d+\.\d+(?:-[\w.]+)?$/,
    example: "<package>@1.2.3",
  },
  uvx: { pinned: /^[^=]+==\d+(?:\.\d+)*$/, example: "<package>==1.2.3" },
};

/**
 * The package a connection fetches each time it starts, when its command
 * is a package runner: the first argument that isn't a flag. `--from`,
 * `--package` and `-p` name it too.
 */
function fetchedPackage(spec: ConnectionSpec) {
  const runner = RUNNERS[basename(spec.command)];
  if (!runner) return null;
  const args = spec.args;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (["--from", "--package", "-p"].includes(arg))
      return { runner, name: args[index + 1] ?? "" };
    const joined = /^--(?:from|package)=(.+)$/.exec(arg);
    if (joined) return { runner, name: joined[1]! };
    if (!arg.startsWith("-")) return { runner, name: arg };
  }
  return { runner, name: "" };
}

/**
 * Whether each connection a package runner fetches names an exact version.
 * One that doesn't may run another release at each start, unreviewed: plan
 * says so (`?`), which doesn't stop apply.
 */
export function pinChecks(setup: Pick<ProjectSetup, "connections">) {
  return setup.connections.flatMap(({ name, spec }) => {
    const fetched = fetchedPackage(spec);
    if (!fetched) return [];
    const check = `connection ${name}`;
    return fetched.runner.pinned.test(fetched.name)
      ? [
          {
            name: check,
            ok: true,
            detail: `runs ${fetched.name}, an exact version`,
          },
        ]
      : [
          {
            name: check,
            ok: true,
            unverified: true,
            detail: `runs ${fetched.name || "a package"} with no exact version, so each start may fetch another release. Name one, as ${fetched.runner.example}`,
          },
        ];
  });
}

/**
 * The data of connections apply last set up that nodrail.yaml no longer
 * declares: apply removes the connection, never what it kept.
 */
export function goneDataNotes(
  data: Record<string, string[]> | undefined,
  setup: Pick<ProjectSetup, "connections">,
) {
  const declared = new Set(setup.connections.map((each) => each.name));
  return Object.entries(data ?? {})
    .filter(([name]) => !declared.has(name))
    .map(
      ([name, paths]) =>
        `Connection ${name} is gone from nodrail.yaml: apply removes it, and keeps its data at ${paths.join(", ")}, which agents can then reach with file tools. Move or delete it yourself if they shouldn't.`,
    );
}

/**
 * Starts each connection once, as the host would, to list its tools. Only
 * `apply` does this, after the person accepted the plan: until then, no code
 * from the project runs and no secret is read.
 */
export function startChecks(input: {
  root: string;
  setup: Pick<ProjectSetup, "connections">;
  env: Env;
}): Promise<ConnectionCheck[]> {
  return Promise.all(
    input.setup.connections.map(({ name, spec }) =>
      healthCheck({ root: input.root, name, spec, env: input.env }),
    ),
  );
}

const HEALTH_TIMEOUT = 15_000;

/**
 * Starts the connection once, as the host would, and asks for its tools:
 * it calls none. Each declared operation must be one of them, with the
 * argument its resource comes from.
 */
export async function healthCheck(input: {
  root: string;
  name: string;
  spec: ConnectionSpec;
  env: Env;
}): Promise<ConnectionCheck> {
  const { name, spec } = input;
  const check = (ok: boolean, detail: string) => ({
    name: `connection ${name}`,
    ok,
    detail,
  });
  let tools: { name?: string; inputSchema?: { properties?: object } }[];
  try {
    tools = await listTools(input);
  } catch (error) {
    return check(false, `didn't start: ${(error as Error).message}`);
  }
  const missing: string[] = [];
  for (const [operation, { resource }] of Object.entries(spec.operations)) {
    const tool = tools.find((each) => each.name === operation);
    if (!tool) missing.push(`no tool ${operation}`);
    else if (
      resource &&
      !Object.hasOwn(tool.inputSchema?.properties ?? {}, resource.from)
    )
      missing.push(`${operation} takes no ${resource.from}`);
  }
  return missing.length > 0
    ? check(false, `doesn't match its declaration: ${missing.join("; ")}`)
    : check(true, `offers ${Object.keys(spec.operations).join(", ")}`);
}

type Tool = { name?: string; inputSchema?: { properties?: object } };

function listTools(input: {
  root: string;
  spec: ConnectionSpec;
  env: Env;
}): Promise<Tool[]> {
  return askServer<Tool[]>({
    command: input.spec.command,
    args: input.spec.args,
    cwd: input.root,
    env: connectionEnv(input.spec, input.env, input.root),
    timeout: HEALTH_TIMEOUT,
    first: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "nodrail-plan", version: "0" },
      },
    },
    answer: (message, send, finish) => {
      if (message.id === 1) {
        send({ jsonrpc: "2.0", method: "notifications/initialized" });
        send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      } else if (message.id === 2)
        finish((message.result as { tools?: Tool[] } | undefined)?.tools ?? []);
    },
  });
}

/**
 * Each connection as an MCP server entry nodrail starts, by the connections
 * file's full path; a fromEnv secret is passed by name, as the host expands
 * it, never written. `shape` adds the host's own fields.
 */
export function mcpServerEntries(
  root: string,
  connections: ProjectSetup["connections"],
  shape: Record<string, unknown>,
) {
  const file = join(realpathSync(root), CONNECTIONS_FILE);
  return Object.fromEntries(
    connections.map(({ name, spec }) => {
      const names = envNames(spec);
      const env = Object.fromEntries(
        names.map((each) => [each, `\${${each}}`]),
      );
      return [
        name,
        {
          ...shape,
          command: "nodrail",
          args: runnerArgs(file, name),
          ...(names.length > 0 ? { env } : {}),
        },
      ];
    }),
  );
}
