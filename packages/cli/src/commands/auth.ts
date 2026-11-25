import { ApiError, NodrailApi } from "../api.ts";
import {
  forgetToken,
  looksLikeSession,
  looksLikeToken,
  resolveToken,
  saveToken,
} from "../config.ts";
import type { Command } from "../context.ts";
import { whoami } from "../format.ts";
import { UsageError } from "../io.ts";
import { browserLogin } from "./browser-login.ts";

export async function login(command: Command) {
  noArgs(command);
  const { io, url, values } = command;
  const scripted = values["token-stdin"];
  const token = scripted
    ? (await io.readStdin()).trim()
    : await browserLogin(command);
  if (scripted && !looksLikeToken(token))
    throw new UsageError(
      "Use a personal API token (ndp_…) with --token-stdin.",
    );
  const api = new NodrailApi({
    token,
    url,
    workspace: values.workspace,
    fetch: io.fetch,
  });
  const me = await api.me().catch((error: unknown) => {
    if (!scripted && error instanceof ApiError && error.status === 404)
      return null;
    throw error;
  });
  const previous = await resolveToken({}, io.home, url);
  await saveToken(
    io.home,
    url,
    token,
    scripted ? me?.workspace.slug : undefined,
  );
  if (previous && looksLikeSession(previous))
    await new NodrailApi({ token: previous, url, fetch: io.fetch }).logout();
  command.print(me ?? { origin: url }, () =>
    me
      ? `Logged in.\n${whoami(me, url)}`
      : values.workspace
        ? `Logged in to ${url}.`
        : `Logged in to ${url}. Create or join a workspace in the console.`,
  );
  if (io.env.NODRAIL_TOKEN)
    io.err("Note: NODRAIL_TOKEN is set and is used instead for its origin.");
}

export async function logout(command: Command) {
  noArgs(command);
  const { io, url } = command;
  const token = await resolveToken({}, io.home, url);
  if (token && looksLikeSession(token))
    await new NodrailApi({ token, url, fetch: io.fetch }).logout();
  const removed = await forgetToken(io.home, url);
  command.print({ removed }, () =>
    removed
      ? token && looksLikeSession(token)
        ? `Logged out of ${url}.`
        : "Logged out. The personal token can still be revoked under your account → API tokens."
      : "No saved token for this Nodrail.",
  );
}

export async function showWhoami(command: Command) {
  noArgs(command);
  const me = await (await command.api()).me();
  command.print(me, () => whoami(me, command.url));
}

export function requireArg(command: Pick<Command, "args">, name: string) {
  const [value, extra] = command.args;
  if (!value) throw new UsageError(`Missing ${name}.`);
  if (extra !== undefined) throw new UsageError(`Unexpected "${extra}".`);
  return value;
}

export const noArgs = (command: Pick<Command, "args">) => {
  if (command.args.length)
    throw new UsageError(`Unexpected "${command.args[0]}".`);
};
