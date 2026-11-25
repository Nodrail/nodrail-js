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

type Subcommand = {
  validate(rest: string[]): unknown;
  run(rest: string[], io: Io): Promise<number> | number;
};

export function parsedSubcommand<T>(
  parse: (rest: string[]) => T,
  run: (input: T, io: Io) => Promise<number> | number,
): Subcommand {
  return { validate: parse, run: (rest, io) => run(parse(rest), io) };
}

function subcommandOf(
  table: Record<string, Subcommand>,
  name: string | undefined,
) {
  return name !== undefined && Object.hasOwn(table, name)
    ? table[name]
    : undefined;
}

export function checkSubcommand(
  table: Record<string, Subcommand>,
  usage: string,
  [name, ...rest]: string[],
) {
  if (name === "--help" || name === "-h") return;
  const command = subcommandOf(table, name);
  if (!command) throw new UsageError(usage);
  command.validate(rest);
}

/** Runs `<what> …` from the table; usage when there is no such subcommand. */
export async function runSubcommand(
  table: Record<string, Subcommand>,
  usage: string,
  args: string[],
  io: Io,
): Promise<number> {
  const [what, ...rest] = args;
  const command = subcommandOf(table, what);
  try {
    if (!command) {
      io.out(usage);
      return what === "--help" || what === "-h" ? 0 : 2;
    }
    return await command.run(rest, io);
  } catch (error) {
    io.err(`nodrail: ${describeFailure(error)}`);
    if (error instanceof UsageError) io.err(usage);
    return exitCodeOf(error);
  }
}
