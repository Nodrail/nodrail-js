// What `nodrail evidence` and `nodrail budgets` share: commands with their
// own flags, run outside the main table so `evidence run` can pass
// everything after `--` to its command, answering their own exit codes.
import { parseArgs, type ParseArgsConfig } from "node:util";
import { describeFailure, exitCodeOf, UsageError, type Io } from "../io.ts";

/** `parseArgs` with positionals, strict; a bad flag is a usage error. */
export function parseFlags<T extends NonNullable<ParseArgsConfig["options"]>>(
  args: string[],
  options: T,
) {
  try {
    return parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
}

export type Subcommand = (rest: string[], io: Io) => Promise<number> | number;

/** Runs `<what> …` from the table; usage when there is no such subcommand. */
export async function runSubcommand(
  table: Record<string, Subcommand>,
  usage: string,
  args: string[],
  io: Io,
): Promise<number> {
  const [what, ...rest] = args;
  const command =
    what !== undefined && Object.hasOwn(table, what) ? table[what] : undefined;
  try {
    if (!command) {
      io.out(usage);
      return what === "--help" || what === "-h" ? 0 : 2;
    }
    return await command(rest, io);
  } catch (error) {
    io.err(`nodrail: ${describeFailure(error)}`);
    if (error instanceof UsageError) io.err(usage);
    return exitCodeOf(error);
  }
}
