// Existing Claude Code settings may still call this after a CLI upgrade.
// It delegates to the policy hook so the host applies its local guards.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import type { Io } from "../io.ts";
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

export function legacyConnect(args: string[], io: Io) {
  const [command, ...rest] = args;
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      "protect-list": { type: "string" },
      connections: { type: "string" },
    },
    allowPositionals: true,
  });
  const [file] = positionals;
  if (
    command !== "hook" ||
    !file ||
    positionals.length !== 1 ||
    !values["protect-list"]
  ) {
    io.err(
      "Usage: nodrail connect hook <file> --protect-list <file> [--connections <file>]",
    );
    return 2;
  }
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
      values["protect-list"],
      ...(values.connections ? ["--connections", values.connections] : []),
      ...(agent ? ["--agent", agent] : []),
    ],
    io,
  );
}
