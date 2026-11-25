// `nodrail connection run <file> <name>`: how a host starts one of the
// setup's tool connections. It reads the secrets the connection names, starts
// it with only those and what any program needs, and hands it the host's
// stdio. A secret is never in the host's config, the arguments or a file.
// A connection whose operations declare `input` or `output` is mediated
// instead: every call is checked on its way to the provider and back.
import type { StdioOptions } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { connectionsField } from "@nodrail/policy-engine/yaml";
import { z } from "zod";
import type { Env } from "../config.ts";
import type { CompiledContracts } from "../contracts/engine.ts";
import type { Io } from "../io.ts";
import { connectionEnv } from "../setup/connections.ts";
import { spawn } from "../spawn.js";
import { VERSION } from "../version.ts";
import { serveMediated } from "./connector.ts";

const file = z.object({
  connections: connectionsField,
  /** Written by apply for each connection with a declared input or output. */
  contracts: z
    .record(
      z.string(),
      z.object({
        bindings: z.array(
          z.object({
            name: z.string(),
            surface: z.string(),
            shape: z.string().nullable(),
          }),
        ),
        shapes: z.record(z.string(), z.unknown()),
      }),
    )
    .optional(),
});

/** One connection as apply wrote it: its spec, project folder and contracts. */
export function readConnection(path: string, name: string) {
  const parsed = file.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) throw new Error(`${path} isn't a connections file`);
  const spec = parsed.data.connections[name];
  if (!spec) throw new Error(`${path} has no connection ${name}`);
  const declared = parsed.data.contracts?.[name];
  return {
    spec,
    root: resolve(dirname(path), ".."),
    // Only what mediation reads (bindings and shapes), as apply compiled it.
    contracts: (declared ?? null) as CompiledContracts | null,
  };
}

/** Starts the connection; the project folder is the one holding `.nodrail`. */
export function startConnection(
  path: string,
  name: string,
  env: Env,
  stdio: StdioOptions = "inherit",
) {
  const { spec, root } = readConnection(path, name);
  return spawn(spec.command, spec.args, {
    cwd: root,
    env: connectionEnv(spec, env, root),
    stdio,
  });
}

/**
 * Serves a connection with declared contracts on these streams, its calls
 * checked; false when it declares none, so it is started as it is.
 */
export async function runMediated(
  path: string,
  name: string,
  env: Env,
  streams: { stdin: Readable; stdout: Writable },
) {
  const { spec, root, contracts } = readConnection(path, name);
  if (contracts === null) return false;
  await serveMediated({
    connection: name,
    command: spec.command,
    args: spec.args,
    env: connectionEnv(spec, env, root),
    root,
    contracts,
    version: VERSION,
    ...streams,
  });
  return true;
}

/** Runs `nodrail connection <args>` and answers its exit code. */
export async function connection(args: string[], io: Io): Promise<number> {
  const [verb, path, name, ...rest] = args;
  if (verb !== "run" || !path || !name || rest.length > 0) {
    io.err("Usage: nodrail connection run <connections file> <name>");
    return 2;
  }
  try {
    const streams = { stdin: process.stdin, stdout: process.stdout };
    if (await runMediated(path, name, io.env, streams)) return 0;
  } catch (error) {
    // stdout is the host's protocol channel: errors go to stderr only.
    io.err(`nodrail: connection ${name}: ${(error as Error).message}`);
    return 1;
  }
  return new Promise((done) => {
    let child: ReturnType<typeof startConnection>;
    try {
      child = startConnection(path, name, io.env);
    } catch (error) {
      // stdout is the host's protocol channel: errors go to stderr only.
      io.err(`nodrail: connection ${name}: ${(error as Error).message}`);
      done(1);
      return;
    }
    const stop = () => child.kill();
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    child.on("error", (error) => {
      io.err(`nodrail: connection ${name}: ${error.message}`);
      done(1);
    });
    child.on("exit", (code, signal) => done(code ?? (signal ? 1 : 0)));
  });
}
