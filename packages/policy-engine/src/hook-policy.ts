import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { compilePolicies } from "./compile.ts";
import type { HookConnection } from "./hook-connection.ts";
import type { RemoteConfig } from "./evidence-remote.ts";
import type { PolicyDocument } from "./policies.ts";
import { secretName, secretValue } from "./secret-refs.ts";
import { spoolFolder } from "./telemetry.ts";

const digest = z.string().regex(/^[0-9a-f]{64}$/);
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

const source = z.object({ digest, text: z.string() });
const livePolicy = z.object({ source: source.nullable() });
const cachedPolicy = z.object({
  scope: digest,
  etag: z.unknown(),
  validator_mac: z.unknown(),
  source,
});

const entityTag = z.string().regex(/^(?:W\/)?"[^"\s]*"$/);
type Cached = z.infer<typeof cachedPolicy> & { etag: string | null };
type Source = z.infer<typeof source>;

const validatorMac = (
  token: string,
  scope: string,
  pin: string,
  etag: string,
) =>
  createHmac("sha256", token)
    .update(JSON.stringify(["nodrail-policy-validator", scope, pin, etag]))
    .digest("hex");

async function readCache(
  file: string,
  scope: string,
  pin: string,
  token: string,
) {
  try {
    const cache = cachedPolicy.parse(JSON.parse(await readFile(file, "utf8")));
    if (
      cache.scope !== scope ||
      cache.source.digest !== pin ||
      hash(cache.source.text) !== pin
    )
      return null;
    const tag = entityTag.safeParse(cache.etag);
    const etag =
      tag.success &&
      cache.validator_mac === validatorMac(token, scope, pin, tag.data)
        ? tag.data
        : null;
    return { ...cache, etag };
  } catch {
    return null;
  }
}

async function saveCache(file: string, cache: Cached) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(temporary, JSON.stringify(cache), {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, file);
  } catch {
    await rm(temporary, { force: true }).catch(() => {});
    // The verified response still decides this call.
  }
}

function readJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

type Pull = { source: Source; etag: string | null; save: boolean };

async function pullPolicy(
  config: RemoteConfig,
  cache: Cached | null,
  fetcher: typeof fetch,
): Promise<Pull | string> {
  const offline = () =>
    cache
      ? { source: cache.source, etag: cache.etag, save: false }
      : "the control plane is unreachable and no cached policy matches the lock";
  let response: Response;
  try {
    response = await fetcher(`${config.url}/api/v1/runtime/policy`, {
      headers: {
        authorization: `Bearer ${config.token}`,
        ...(cache?.etag ? { "if-none-match": cache.etag } : {}),
      },
      redirect: "error",
      signal: AbortSignal.timeout(3_000),
    });
  } catch {
    return offline();
  }
  if (response.status === 304 && cache?.etag)
    return { source: cache.source, etag: cache.etag, save: false };
  if ([408, 429].includes(response.status) || response.status >= 500)
    return offline();
  if (!response.ok) return `policy fetch returned HTTP ${response.status}`;
  const payload = await response.text().catch(() => undefined);
  if (payload === undefined) return offline();
  const parsed = livePolicy.safeParse(readJson(payload));
  if (!parsed.success) return "the control plane returned an invalid policy";
  if (!parsed.data.source) return "the live policy has no published source";
  return {
    source: parsed.data.source,
    etag: entityTag.safeParse(response.headers.get("etag")).data ?? null,
    save: true,
  };
}

export type HookPolicy = {
  document?: PolicyDocument;
  digest?: string;
  evidence: RemoteConfig | null;
  watch: boolean;
};

/** Resolve the setup's policy before any call reaches the evaluator. */
export async function loadHookPolicy(
  file: string,
  settings: HookConnection,
  env: Record<string, string | undefined>,
  io: { fetch?: typeof fetch; home?: string } = {},
): Promise<HookPolicy | string> {
  const blocked = (reason: string) => `Nodrail: ${reason}. See nodrail plan.\n`;
  const watch = settings.enforce === "watch";
  if (settings.decide === "local") return { watch, evidence: null };

  let token: string;
  try {
    token = secretValue(settings.credential, env);
  } catch {
    return blocked(
      `${secretName(settings.credential)} isn't set; the connected hook needs its credential`,
    );
  }
  const fetcher = io.fetch ?? fetch;
  const url = settings.url.replace(/\/+$/, "");
  const evidence = {
    url,
    token,
    workspaceRevision: settings.workspace_revision,
    runtime: true,
    fetch: fetcher,
  };
  const pin = settings.policy_digest;
  const scope = hash(`${url}\n${token}\n${settings.workspace_revision}`);
  // Policy refreshes cannot change the work revision that evidence covers.
  const folder = spoolFolder(io.home ?? homedir(), file, "policies");
  const cacheFile = join(folder, "live.json");
  const cache = await readCache(cacheFile, scope, pin, token);
  const pulled = await pullPolicy(evidence, cache, fetcher);
  if (typeof pulled === "string") return blocked(pulled);
  if (pulled.source.digest !== pin || hash(pulled.source.text) !== pin)
    return blocked("the live policy digest doesn't match the lock");
  const compiled = compilePolicies([{ name: file, text: pulled.source.text }]);
  if (!compiled.ok) return blocked("the verified policy can't be compiled");
  if (pulled.save)
    await saveCache(cacheFile, {
      scope,
      etag: pulled.etag,
      validator_mac: pulled.etag
        ? validatorMac(token, scope, pin, pulled.etag)
        : undefined,
      source: pulled.source,
    });
  return { document: compiled.document, digest: pin, evidence, watch };
}
