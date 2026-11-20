import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { Command } from "../context.ts";
import { UsageError } from "../io.ts";
import {
  hostStatuses,
  observation,
  recordObservation,
  sendObservation,
} from "../setup/observe.ts";

/**
 * `nodrail observe <folder>`: records the project's latest observation in
 * the home folder, as `nodrail status` sees it. The session-start hook runs
 * it with `--detach`, which starts it apart and returns at once, so a
 * session never waits for it. It changes nothing in the project and always
 * exits 0: an observation that can't be made is just not recorded.
 */
export async function observe(command: Command) {
  const { io, values } = command;
  if (command.args.length !== 1)
    throw new UsageError(
      "Usage: nodrail observe <project folder> [--names] [--detach]",
    );
  const root = resolve(io.cwd, command.args[0]!);
  if (values.detach) {
    const child = spawn(
      process.execPath,
      [
        ...(io.self ?? [process.argv[1] ?? ""]),
        "observe",
        root,
        ...(values.names ? ["--names"] : []),
      ],
      { detached: true, stdio: "ignore", env: io.env as NodeJS.ProcessEnv },
    );
    child.on("error", () => undefined);
    child.unref();
    return;
  }
  try {
    const statuses = await hostStatuses({ root, home: io.home, env: io.env });
    if (statuses.length === 0) return;
    const record = observation(root, statuses, values.names === true);
    recordObservation(io.home, root, record);
    // The telemetry sender runs this command line again.
    sendObservation(io.home, root, record, [
      ...(io.self ?? [process.argv[1] ?? ""]),
      "policy",
    ]);
  } catch {
    // Observing never fails a session: the next start tries again.
  }
}
