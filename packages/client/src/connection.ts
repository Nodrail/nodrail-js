import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { canonicalOrigin } from "@nodrail/policy-engine/actions";

export const DEFAULT_URL = "https://app.nodrail.com";

export type Environment = Record<string, string | undefined>;

type Connection = { url: string; credential: string | null; error?: string };
const pairError =
  "Pair NODRAIL_URL with NODRAIL_CREDENTIAL, or CLAUDE_PLUGIN_OPTION_URL with CLAUDE_PLUGIN_OPTION_CREDENTIAL. Remove conflicting settings. Use https, or http on localhost.";

const unpaired: Connection = {
  url: DEFAULT_URL,
  credential: null,
  error: pairError,
};

function savedConnection(env: Environment): Connection {
  const home = env.NODRAIL_HOME ?? join(homedir(), ".nodrail");
  let credential: string;
  try {
    credential = readFileSync(join(home, "credential"), "utf8").trim();
  } catch {
    return { url: DEFAULT_URL, credential: null };
  }
  if (!credential) return { url: DEFAULT_URL, credential: null };
  try {
    const url = canonicalOrigin(readFileSync(join(home, "url"), "utf8").trim());
    return { url, credential };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { url: DEFAULT_URL, credential }
      : unpaired;
  }
}

export function resolveSdkConnection(
  env: Environment,
  url?: string,
  credential?: string,
): Connection {
  if (credential !== undefined)
    return url && credential
      ? resolveConnection({ NODRAIL_URL: url, NODRAIL_CREDENTIAL: credential })
      : unpaired;
  const resolved = resolveConnection(env);
  if (url === undefined) return resolved;
  try {
    return resolved.credential && resolved.url === canonicalOrigin(url)
      ? resolved
      : unpaired;
  } catch {
    return unpaired;
  }
}

export function resolveConnection(env: Environment): Connection {
  const pairs = [
    [env.NODRAIL_URL, env.NODRAIL_CREDENTIAL],
    [env.CLAUDE_PLUGIN_OPTION_URL, env.CLAUDE_PLUGIN_OPTION_CREDENTIAL],
  ].filter(([url, credential]) => url || credential);
  if (!pairs.length) return savedConnection(env);
  try {
    const [first, second] = pairs.map(([url, credential]) => {
      if (!url || !credential) throw new Error(pairError);
      return { url: canonicalOrigin(url), credential };
    });
    if (
      !second ||
      (first!.url === second.url && first!.credential === second.credential)
    )
      return first!;
  } catch {
    return unpaired;
  }
  return unpaired;
}
