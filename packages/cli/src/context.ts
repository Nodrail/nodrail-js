import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { NodrailApi, visibleLines } from "./api.ts";
import {
  heldBackToken,
  resolveToken,
  resolveUrl,
  savedOrigin,
} from "./config.ts";
import { CliError, type Io } from "./io.ts";

export type Values = {
  json?: boolean;
  environment?: string;
  workspace?: string;
  url?: string;
  yes?: boolean;
  agent?: string;
  runtime?: string;
  "require-active"?: boolean;
  "replace-live"?: boolean;
  check?: boolean;
  details?: boolean;
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
  api(root?: string): Promise<NodrailApi>;
  /** Machine output on stdout, or the person's text. */
  print(value: unknown, text: () => string): void;
  /** Notes for the person; on stderr with --json so stdout stays parseable. */
  say(text: string): void;
};

export async function commandFor(
  io: Io,
  values: Values,
  args: string[],
  name: string,
): Promise<Command> {
  const origin = name === "login" ? undefined : await savedOrigin(io.home);
  const project = ["login", "logout"].includes(name)
    ? null
    : connectionAt(io.cwd);
  const urlFor = (connection: typeof project) =>
    connection && !values.url && !io.env.NODRAIL_URL
      ? resolveUrl({}, connection.url)
      : resolveUrl(io.env, values.url, origin);
  const url = urlFor(project);
  return {
    io,
    values,
    args,
    url,
    async api(root = io.cwd) {
      const connection = root === io.cwd ? project : connectionAt(root);
      const destination = urlFor(connection);
      const workspace = values.workspace ?? connection?.workspace;
      const token = await resolveToken(io.env, io.home, destination, workspace);
      if (!token)
        throw new CliError(
          `Not logged in to ${destination}. Run \`nodrail login --url ${destination}\`, or set NODRAIL_TOKEN.${heldBackToken(io.env, destination)}`,
        );
      return new NodrailApi({
        token,
        url: destination,
        workspace,
        environment: values.environment ?? connection?.environment,
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

/** Project coordinates are explicit; a bare command outside a project uses the last login. */
function connectionAt(root: string) {
  try {
    const connect = parse(readFileSync(join(root, "nodrail.yaml"), "utf8"))
      ?.connect as
      | {
          decide?: string;
          url?: string;
          workspace?: string;
          environment?: string;
        }
      | undefined;
    return connect?.decide === "cloud" ? connect : null;
  } catch {
    return null;
  }
}
