// `nodrail connection run <file> <name>`: how a host starts one of the
// setup's tool connections. It reads the secrets the connection names, starts
// it with only those and what any program needs, and hands it the host's
// stdio. A secret is never in the host's config, the arguments or a file.
import { spawn, type StdioOptions } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { connectionsField } from "@nodrail/policy-engine/yaml";
import { z } from "zod";
import type { Env } from "../config.ts";
import type { Io } from "../io.ts";
import { connectionEnv } from "../setup/connections.ts";

const file = z.object({ connections: connectionsField });

/** Starts the connection; the project folder is the one holding `.nodrail`. */
export function startConnection(
  path: string,
  name: string,
  env: Env,
  stdio: StdioOptions = "inherit",
) {
  const parsed = file.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) throw new Error(`${path} isn't a connections file`);
  const spec = parsed.data.connections[name];
  if (!spec) throw new Error(`${path} has no connection ${name}`);
  const root = resolve(dirname(path), "..");
  return spawn(spec.command, spec.args, {
    cwd: root,
    env: connectionEnv(spec, env, root),
    stdio,
    shell: process.platform === "win32",
  });
}

/** Runs `nodrail connection <args>` and answers its exit code. */
export function connection(args: string[], io: Io): Promise<number> {
  const [verb, path, name, ...rest] = args;
  if (verb !== "run" || !path || !name || rest.length > 0) {
    io.err("Usage: nodrail connection run <connections file> <name>");
    return Promise.resolve(2);
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
