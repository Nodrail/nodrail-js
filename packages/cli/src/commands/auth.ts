import { NodrailApi } from "../api.ts";
import { forgetToken, looksLikeToken, saveToken } from "../config.ts";
import type { Command } from "../context.ts";
import { whoami } from "../format.ts";
import { UsageError } from "../io.ts";

async function readToken(command: Command) {
  const { io, values } = command;
  if (values["token-stdin"]) return (await io.readStdin()).trim();
  if (!io.interactive)
    throw new UsageError(
      "No terminal to paste a token into. Use `--token-stdin`, or set NODRAIL_TOKEN.",
    );
  io.err(
    "Create a token in Nodrail: your account → API tokens. It starts with ndp_.",
  );
  return (await io.ask("Token: ", { hidden: true })).trim();
}

export async function login(command: Command) {
  noArgs(command);
  const token = await readToken(command);
  if (token.startsWith("ndr_"))
    throw new UsageError(
      "That is an agent's credential (ndr_). The command line takes a personal token (ndp_).",
    );
  if (!looksLikeToken(token))
    throw new UsageError("That doesn't look like a personal token (ndp_…).");
  const me = await new NodrailApi({
    token,
    url: command.url,
    fetch: command.io.fetch,
  }).me();
  await saveToken(command.io.home, command.url, token);
  command.print(me, () => `Logged in.\n${whoami(me, command.url)}`);
  if (command.io.env.NODRAIL_TOKEN)
    command.io.err("Note: NODRAIL_TOKEN is set and is used instead.");
}

export async function logout(command: Command) {
  noArgs(command);
  const removed = await forgetToken(command.io.home, command.url);
  command.print({ removed }, () =>
    removed
      ? "Logged out. The token still works until you revoke it under your account → API tokens."
      : "No saved token for this Nodrail.",
  );
}

export async function showWhoami(command: Command) {
  noArgs(command);
  const me = await (await command.api()).me();
  command.print(me, () => whoami(me, command.url));
}

export function requireArg(command: Command, name: string) {
  const [value, extra] = command.args;
  if (!value) throw new UsageError(`Missing ${name}.`);
  if (extra !== undefined) throw new UsageError(`Unexpected "${extra}".`);
  return value;
}

export const noArgs = (command: Command) => {
  if (command.args.length)
    throw new UsageError(`Unexpected "${command.args[0]}".`);
};
