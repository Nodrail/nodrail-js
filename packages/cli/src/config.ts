import { join } from "node:path";
import {
  canonicalOrigin,
  readSecretFile,
  removeSecretFile,
  writeSecretFile,
} from "@nodrail/policy-engine/command-line";
import { DEFAULT_URL } from "./api.ts";
import { CliError } from "./io.ts";

/** Tokens saved by `nodrail login`, one per Nodrail URL. */
type Stored = {
  tokens: Record<string, string>;
  workspaceTokens?: Record<string, Record<string, string>>;
  origin?: string;
};

export const configPath = (home: string) => join(home, ".nodrail", "cli.json");

async function readStored(home: string): Promise<Stored> {
  try {
    const text = readSecretFile(configPath(home));
    if (text === null) return { tokens: {} };
    const parsed = JSON.parse(text) as Partial<Stored>;
    return { ...parsed, tokens: { ...parsed.tokens } };
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { tokens: {} };
  }
}

/** Only the owner can read the file or list the folder. */
async function writeStored(home: string, stored: Stored) {
  const path = configPath(home);
  if (Object.keys(stored.tokens).length === 0) {
    removeSecretFile(path);
    return;
  }
  writeSecretFile(path, `${JSON.stringify(stored, null, 2)}\n`);
}

export function normalizeUrl(value: string) {
  try {
    return canonicalOrigin(value);
  } catch (error) {
    throw new CliError((error as Error).message);
  }
}

export type Env = Record<string, string | undefined>;

/**
 * `--url`, then `NODRAIL_URL`, then Nodrail Cloud. Tokens travel only over
 * https, except to this computer, so nobody on the network can read one.
 */
export async function savedOrigin(home: string) {
  return (await readStored(home)).origin;
}

export function resolveUrl(env: Env, flag?: string, fallback?: string) {
  return normalizeUrl(flag || env.NODRAIL_URL || fallback || DEFAULT_URL);
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

export async function resolveToken(
  env: Env,
  home: string,
  url: string,
  workspace?: string,
) {
  if (env.NODRAIL_TOKEN && normalizeUrl(url) === resolveUrl(env))
    return env.NODRAIL_TOKEN.trim();
  const saved = await readStored(home);
  const origin = normalizeUrl(url);
  const main = saved.tokens[origin];
  if (!workspace || main?.startsWith("ndc_")) return main ?? null;
  const scoped = saved.workspaceTokens?.[origin];
  return scoped && Object.hasOwn(scoped, workspace)
    ? (scoped[workspace] ?? null)
    : (main ?? null);
}

export async function saveToken(
  home: string,
  url: string,
  token: string,
  workspace?: string,
) {
  const stored = await readStored(home);
  const origin = normalizeUrl(url);
  stored.origin = origin;
  stored.tokens[origin] = token;
  if (workspace)
    ((stored.workspaceTokens ??= {})[origin] ??= {})[workspace] = token;
  await writeStored(home, stored);
}

export async function forgetToken(home: string, url: string) {
  const stored = await readStored(home);
  const had = normalizeUrl(url) in stored.tokens;
  delete stored.tokens[normalizeUrl(url)];
  delete stored.workspaceTokens?.[normalizeUrl(url)];
  if (stored.origin === normalizeUrl(url))
    stored.origin = Object.keys(stored.tokens).at(-1);
  if (had) await writeStored(home, stored);
  return had;
}

const tokenPattern = /^ndp_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/;

/** A personal token, never an agent's `ndr_` credential. */
export const looksLikeToken = (value: string) => tokenPattern.test(value);

export const looksLikeSession = (value: string) =>
  /^ndc_[A-Za-z0-9_-]{43}$/.test(value);
