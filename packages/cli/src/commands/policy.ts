// `nodrail policy`: the offline rules commands, with no account. They are
// nodrail-policy's own command line, run in-process, so both behave the same.
import {
  runPolicyCommandLine,
  type Io as EngineIo,
} from "@nodrail/policy-engine/command-line";
import type { Io } from "../io.ts";
import { exportFrozen, lock } from "./project.ts";

/** A subcommand of `nodrail policy` that nodrail-policy doesn't have. */
export type PolicySubcommand = (args: string[], io: Io) => Promise<number>;

/**
 * Subcommands `nodrail policy` adds to nodrail-policy's, by name: lock and
 * export work on a project's nodrail.yaml. Anything not
 * here goes to nodrail-policy: init, validate, compile, eval, test, check,
 * exec, hook and runs, with their flags, output and exit codes.
 */
const ownSubcommands: ReadonlyMap<string, PolicySubcommand> = new Map([
  ["lock", lock],
  ["export", exportFrozen],
]);

const engineIo = (io: Io): EngineIo => ({
  log: (text) => io.out(text),
  error: (text) => io.err(text),
  write: (text) => io.write(text),
  writeError: (text) => io.writeErr(text),
  readStdin: () => io.readStdin(),
});

/** Runs `nodrail policy <args>` and answers its exit code. */
export function policy(
  args: string[],
  io: Io,
  subcommands = ownSubcommands,
): Promise<number> {
  const [name = "", ...rest] = args;
  const own = subcommands.get(name);
  if (own) return own(rest, io);
  return runPolicyCommandLine(args, engineIo(io));
}
