import { NodrailApi, visibleLines } from "./api.ts";
import { heldBackToken, resolveToken, resolveUrl } from "./config.ts";
import { CliError, type Io } from "./io.ts";

export type Values = {
  json?: boolean;
  environment?: string;
  url?: string;
  yes?: boolean;
  agent?: string;
  runtime?: string;
  "require-active"?: boolean;
  "replace-live"?: boolean;
  check?: boolean;
  detach?: boolean;
  names?: boolean;
  q?: string;
  outcome?: string;
  kind?: string;
  range?: string;
  run?: string;
  limit?: string;
  cursor?: string;
  days?: string;
  "token-stdin"?: boolean;
};

/** What one command gets: its arguments, the terminal and the API. */
export type Command = {
  io: Io;
  values: Values;
  args: string[];
  url: string;
  api(): Promise<NodrailApi>;
  /** Machine output on stdout, or the person's text. */
  print(value: unknown, text: () => string): void;
  /** Notes for the person; on stderr with --json so stdout stays parseable. */
  say(text: string): void;
};

export function commandFor(io: Io, values: Values, args: string[]): Command {
  const url = resolveUrl(io.env, values.url);
  return {
    io,
    values,
    args,
    url,
    async api() {
      const token = await resolveToken(io.env, io.home, url);
      if (!token)
        throw new CliError(
          `Not logged in. Run \`nodrail login\`, or set NODRAIL_TOKEN.${heldBackToken(io.env, url)}`,
        );
      return new NodrailApi({
        token,
        url,
        environment: values.environment,
        fetch: io.fetch,
      });
    },
    print(value, text) {
      // JSON escapes control characters itself; text is checked once more.
      io.out(
        values.json ? JSON.stringify(value, null, 2) : visibleLines(text()),
      );
    },
    say(text) {
      if (values.json) io.err(visibleLines(text));
      else io.out(visibleLines(text));
    },
  };
}
