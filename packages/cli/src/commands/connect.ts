// Existing Claude Code settings may still call this after a CLI upgrade.
// It delegates to the policy hook so the host applies its local guards.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseFlags } from "./subcommands.ts";
import { UsageError, type Io } from "../io.ts";
import { policy } from "./policy.ts";

function installedAgent(folder: string) {
  try {
    const settings = JSON.parse(
      readFileSync(join(folder, "../.claude/settings.json"), "utf8"),
    ) as { agent?: unknown };
    return typeof settings.agent === "string" ? settings.agent : undefined;
  } catch {
    return undefined;
  }
}

export function parseLegacyConnectArgs(args: string[]) {
  const [command, ...rest] = args;
  const { values, positionals } = parseFlags(rest, {
    "protect-list": { type: "string" },
    connections: { type: "string" },
  });
  const [file] = positionals;
  if (
    command !== "hook" ||
    !file ||
    positionals.length !== 1 ||
    !values["protect-list"]
  )
    throw new UsageError(
      "Usage: nodrail connect hook <file> --protect-list <file> [--connections <file>]",
    );
  return {
    file,
    protectList: values["protect-list"],
    connections: values.connections,
  };
}

export function legacyConnect(args: string[], io: Io) {
  let target: ReturnType<typeof parseLegacyConnectArgs>;
  try {
    target = parseLegacyConnectArgs(args);
  } catch (error) {
    io.err((error as Error).message);
    return 2;
  }
  const { file, protectList, connections } = target;
  const folder = dirname(file);
  const agent = installedAgent(folder);
  return policy(
    [
      "hook",
      join(folder, "effective.yaml"),
      "--connect",
      file,
      "--legacy-connect",
      "--protect-list",
      protectList,
      ...(connections ? ["--connections", connections] : []),
      ...(agent ? ["--agent", agent] : []),
    ],
    io,
  );
}
