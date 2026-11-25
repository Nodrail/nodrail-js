// Externally verified evidence for a local gate: Cloud's answer for one
// requirement of the published workspace revision (gate id and index) and
// the current subject. Cloud evaluates only published requirements, never a
// condition sent from here, so nothing here can probe unreported fields.
// Offline, unpublished, a token without `read`, a timeout or an error all
// leave the requirement unmet with the reason. A positive answer is cached
// for at most 5 minutes per (requirement, subject); a negative one never.
// Node only.
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { evidenceDirectory } from "./evidence.ts";
import type { RemoteStatus } from "./run-evidence.ts";

/** Inside the hook's 15 s deadline, with room for the decision. */
export const REMOTE_TIMEOUT_MS = 3000;
export const POSITIVE_CACHE_MS = 5 * 60_000;

/** Where Cloud is and which published revision to ask about. The token is the person's, with `read`. */
export type RemoteConfig = {
  url: string;
  token: string;
  workspaceRevision: string;
  runtime?: boolean;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

export type RemoteAsk = { gate: string; index: number; subject: string };

/**
 * Cloud's `EvidenceStatusDto`, mirrored from Cloud's evidence contract:
 * Cloud is the source of truth for this shape. A code this engine doesn't
 * know is read, and stays unmet with generic words.
 */
const status = z.object({
  met: z.boolean(),
  reason_code: z.string().min(1).max(64),
  event_id: z.string().max(200).nullable(),
  verifier: z
    .object({
      name: z.string().min(1).max(200),
      revoked_at: z.string().max(64).nullable(),
    })
    .nullable(),
  received_at: z.string().max(64).nullable(),
});

const unmet = (reason: string): RemoteStatus => ({
  met: false,
  reason_code: reason,
  event_id: null,
  verifier: null,
  received_at: null,
});

/** HTTPS, or HTTP to this machine only: the token never travels in the clear. */
function safeUrl(url: string) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:") return true;
    const host = parsed.hostname.replace(/^\[|\]$/g, "");
    return (
      parsed.protocol === "http:" &&
      (host === "localhost" || host === "::1" || /^127(?:\.\d+){3}$/.test(host))
    );
  } catch {
    return false;
  }
}

/** Asks Cloud about one requirement; never throws. */
export async function fetchEvidenceStatus(
  config: RemoteConfig,
  ask: RemoteAsk,
): Promise<RemoteStatus> {
  if (!safeUrl(config.url)) return unmet("offline");
  const query = new URLSearchParams({
    workspace_revision: config.workspaceRevision,
    gate: ask.gate,
    requirement: String(ask.index),
    subject: ask.subject,
  });
  const base = config.url.replace(/\/$/, "");
  try {
    const response = await (config.fetch ?? fetch)(
      `${base}/api/v1${config.runtime ? "/runtime" : ""}/evidence/status?${query.toString()}`,
      {
        headers: { authorization: `Bearer ${config.token}` },
        signal: AbortSignal.timeout(config.timeoutMs ?? REMOTE_TIMEOUT_MS),
        redirect: "error",
      },
    );
    if (response.status === 401 || response.status === 403)
      return unmet("unauthorized");
    if (response.status === 404) return unmet("unpublished");
    if (!response.ok) return unmet("error");
    const parsed = status.safeParse(await response.json());
    return parsed.success ? parsed.data : unmet("error");
  } catch {
    return unmet("offline");
  }
}

const cacheFile = (ledger: string) =>
  join(evidenceDirectory(ledger), "remote-cache.json");
const cacheKey = (scope: string, ask: RemoteAsk) =>
  `${scope}|${ask.gate}|${ask.index}|${ask.subject}`;

const cacheScope = (config: RemoteConfig) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        config.url,
        config.token,
        config.runtime ?? false,
        config.workspaceRevision,
      ]),
    )
    .digest("hex");

type Cache = Record<string, { at: number; status: RemoteStatus }>;

function readCache(ledger: string): Cache {
  try {
    const file = cacheFile(ledger);
    if (!existsSync(file)) return {};
    const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return typeof raw === "object" && raw !== null ? (raw as Cache) : {};
  } catch {
    return {};
  }
}

function writeCache(ledger: string, cache: Cache, now: number) {
  const kept = Object.fromEntries(
    Object.entries(cache).filter(
      ([, entry]) => now - entry.at < POSITIVE_CACHE_MS,
    ),
  );
  try {
    mkdirSync(evidenceDirectory(ledger), { recursive: true });
    const temporary = `${cacheFile(ledger)}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(kept));
    renameSync(temporary, cacheFile(ledger));
  } catch {
    // A cache that can't be written only costs another request.
  }
}

/**
 * Cloud's answers for each ask, all at once: cached positives first, the
 * rest fetched in parallel. Keyed by `<gate>#<index>`.
 */
export async function remoteStatuses(
  config: RemoteConfig | null,
  asks: RemoteAsk[],
  options: { ledger: string; now: Date },
): Promise<Map<string, RemoteStatus>> {
  const found = new Map<string, RemoteStatus>();
  if (!config || !asks.length) return found;
  const now = options.now.getTime();
  const cache = readCache(options.ledger);
  const missing: RemoteAsk[] = [];
  const scope = cacheScope(config);
  for (const ask of asks) {
    const hit = cache[cacheKey(scope, ask)];
    if (hit?.status.met && now - hit.at < POSITIVE_CACHE_MS)
      found.set(`${ask.gate}#${ask.index}`, hit.status);
    else missing.push(ask);
  }
  const answers = await Promise.all(
    missing.map((ask) => fetchEvidenceStatus(config, ask)),
  );
  let changed = false;
  missing.forEach((ask, index) => {
    const answer = answers[index]!;
    found.set(`${ask.gate}#${ask.index}`, answer);
    if (answer.met) {
      cache[cacheKey(scope, ask)] = { at: now, status: answer };
      changed = true;
    }
  });
  if (changed) writeCache(options.ledger, cache, now);
  return found;
}

/**
 * The hook's `--evidence <file>`: `{ url, workspace_revision }` written by
 * the CLI. The token comes from NODRAIL_TOKEN, never from a file.
 */
export function readRemoteConfig(
  file: string,
  env: Record<string, string | undefined>,
): RemoteConfig | null {
  const parsed = z
    .object({
      url: z.string().url(),
      workspace_revision: z.string().min(1).max(200),
    })
    .safeParse(JSON.parse(readFileSync(file, "utf8")));
  const token = env.NODRAIL_TOKEN?.trim();
  if (!parsed.success || !token) return null;
  return {
    url: parsed.data.url,
    token,
    workspaceRevision: parsed.data.workspace_revision,
  };
}
