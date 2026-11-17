import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_URL } from "./api.ts";
import { CliError } from "./io.ts";

/** Tokens saved by `nodrail login`, one per Nodrail URL. */
type Stored = { tokens: Record<string, string> };

export const configPath = (home: string) => join(home, ".nodrail", "cli.json");

async function readStored(home: string): Promise<Stored> {
  try {
    const parsed = JSON.parse(
      await readFile(configPath(home), "utf8"),
    ) as Partial<Stored>;
    return { tokens: { ...parsed.tokens } };
  } catch {
    return { tokens: {} };
  }
}

/** Only the owner can read the file or list the folder. */
async function writeStored(home: string, stored: Stored) {
  const folder = join(home, ".nodrail");
  await mkdir(folder, { recursive: true, mode: 0o700 });
  await chmod(folder, 0o700);
  const path = configPath(home);
  if (Object.keys(stored.tokens).length === 0) {
    await rm(path, { force: true });
    return;
  }
  await writeFile(path, `${JSON.stringify(stored, null, 2)}\n`, {
    mode: 0o600,
  });
  // writeFile keeps the mode of a file that already exists.
  await chmod(path, 0o600);
}

export const normalizeUrl = (url: string) => url.replace(/\/+$/, "");

export type Env = Record<string, string | undefined>;

const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * `--url`, then `NODRAIL_URL`, then Nodrail Cloud. Tokens travel only over
 * https, except to this computer, so nobody on the network can read one.
 */
export function resolveUrl(env: Env, flag?: string) {
  const url = normalizeUrl(flag || env.NODRAIL_URL || DEFAULT_URL);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new CliError(`"${url}" is not a URL.`);
  }
  const local = loopback.has(parsed.hostname);
  if (parsed.protocol !== "https:" && !(local && parsed.protocol === "http:"))
    throw new CliError(
      `Nodrail must be reached over https (${url}); only localhost may use http.`,
    );
  return url;
}

/**
 * `NODRAIL_TOKEN` wins over a saved token, but only for the Nodrail it was
 * set for (`NODRAIL_URL`, else Nodrail Cloud): a `--url` from a project's
 * config never receives it.
 */
/** Why there is no token for this URL although NODRAIL_TOKEN is set, if so. */
export const heldBackToken = (env: Env, url: string) =>
  env.NODRAIL_TOKEN &&
  normalizeUrl(url) !== normalizeUrl(env.NODRAIL_URL || DEFAULT_URL)
    ? ` NODRAIL_TOKEN is only sent to ${normalizeUrl(env.NODRAIL_URL || DEFAULT_URL)}; set NODRAIL_URL too to use it with ${normalizeUrl(url)}.`
    : "";

export async function resolveToken(env: Env, home: string, url: string) {
  const forUrl = normalizeUrl(env.NODRAIL_URL || DEFAULT_URL);
  if (env.NODRAIL_TOKEN && normalizeUrl(url) === forUrl)
    return env.NODRAIL_TOKEN.trim();
  return (await readStored(home)).tokens[normalizeUrl(url)] ?? null;
}

export async function saveToken(home: string, url: string, token: string) {
  const stored = await readStored(home);
  stored.tokens[normalizeUrl(url)] = token;
  await writeStored(home, stored);
}

export async function forgetToken(home: string, url: string) {
  const stored = await readStored(home);
  const had = normalizeUrl(url) in stored.tokens;
  delete stored.tokens[normalizeUrl(url)];
  if (had) await writeStored(home, stored);
  return had;
}

const tokenPattern = /^ndp_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/;

/** A personal token, never an agent's `ndr_` credential. */
export const looksLikeToken = (value: string) => tokenPattern.test(value);
