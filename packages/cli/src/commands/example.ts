// `nodrail example [name] [folder]`: the example projects this command line
// ships with, copied out so they can be planned and applied. Nothing is
// fetched: they are part of the installed package.
import { cpSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "../context.ts";
import { CliError, UsageError } from "../io.ts";

/** The package's examples folder, from the source tree or the built file. */
export function examplesFolder(from = fileURLToPath(import.meta.url)) {
  for (let folder = dirname(from); ; folder = dirname(folder)) {
    const candidate = join(folder, "examples");
    if (existsSync(join(candidate, "support-desk", "nodrail.yaml")))
      return candidate;
    if (dirname(folder) === folder)
      throw new CliError("This installation has no examples.");
  }
}

const examples = (folder: string) =>
  readdirSync(folder, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

export async function example(command: Command, folder = examplesFolder()) {
  const { io } = command;
  const [name, target, ...rest] = command.args;
  if (rest.length > 0)
    throw new UsageError("Usage: nodrail example [<name> [<folder>]]");
  const names = examples(folder);
  if (name === undefined) {
    command.print({ examples: names }, () =>
      [
        "Examples:",
        ...names.map((each) => `  ${each}`),
        "",
        "Copy one with `nodrail example <name> [<folder>]`.",
      ].join("\n"),
    );
    return;
  }
  if (!names.includes(name))
    throw new UsageError(
      `There is no example ${name}. There are: ${names.join(", ")}.`,
    );
  const destination = resolve(io.cwd, target ?? name);
  if (existsSync(destination) && readdirSync(destination).length > 0)
    throw new CliError(
      `${destination} isn't empty. Name a new folder: nodrail example ${name} <folder>.`,
    );
  cpSync(join(folder, name), destination, { recursive: true });
  const shown = relative(io.cwd, destination) || ".";
  const path = shown.startsWith(".") ? shown : `./${shown}`;
  command.print({ example: name, folder: destination }, () =>
    [
      `Copied the ${name} example to ${path}. Read its README.md, then:`,
      "",
      `  nodrail plan ${path} --runtime claude-code`,
      `  nodrail apply ${path} --runtime claude-code`,
      "",
      "or the same with --runtime codex.",
    ].join("\n"),
  );
}
