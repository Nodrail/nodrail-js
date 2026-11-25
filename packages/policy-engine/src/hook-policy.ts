import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { compilePolicies } from "./compile.ts";
import type { HookConnection } from "./hook-connection.ts";
import type { RemoteConfig } from "./evidence-remote.ts";
import type { PolicyDocument } from "./policies.ts";
import { controlPlaneOrigin, hookCredential } from "./hook-credential.ts";
import { policyRefusal } from "./hook-policy-error.ts";
import { spoolFolder } from "./telemetry.ts";

const digest = z.string().regex(/^[0-9a-f]{64}$/);
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

const source = z.object({ digest, text: z.string() });
const livePolicy = z.object({
  source: source.nullable(),
  denial_reason: z.string().min(1).max(1000).optional(),
});
const cachedPolicy = z.object({
  scope: digest,
  etag: z.unknown(),
  validator_mac: z.unknown().optional(),
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
    if (cache.scope !== scope || !matchesPin(cache.source, pin)) return null;
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

type Pull = {
  source: Source;
  etag: string | null;
  save: boolean;
  offline?: true;
};

async function pullPolicy(
  config: RemoteConfig,
  cache: Cached | null,
  fetcher: typeof fetch,
): Promise<Pull | string | { refusal: string }> {
  const offline = (): Pull | string =>
    cache
      ? { source: cache.source, etag: cache.etag, save: false, offline: true }
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
  if (!response.ok)
    return {
      refusal:
        (await policyRefusal(response)) ??
        `policy fetch returned HTTP ${response.status}`,
    };
  const payload = await response.text().catch(() => undefined);
  if (payload === undefined) return offline();
  return readLivePolicy(payload, response.headers.get("etag"));
}

function readLivePolicy(payload: string, etag: string | null) {
  const parsed = livePolicy.safeParse(readJson(payload));
  if (!parsed.success) return "the control plane returned an invalid policy";
  if (parsed.data.denial_reason) return { refusal: parsed.data.denial_reason };
  if (!parsed.data.source) return "the live policy has no published source";
  return {
    source: parsed.data.source,
    etag: entityTag.safeParse(etag).data ?? null,
    save: true,
  };
}

export type HookPolicy = {
  document?: PolicyDocument;
  digest?: string;
  evidence: RemoteConfig | null;
  watch: boolean;
  warning?: string;
  state?: "live" | "cached";
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
    token = await hookCredential(settings, env, io.home);
  } catch (error) {
    return blocked((error as Error).message);
  }
  const fetcher = io.fetch ?? fetch;
  const url = controlPlaneOrigin(settings.url);
  const evidence = {
    url,
    token,
    workspaceRevision: settings.workspace_revision,
    runtime: true,
    fetch: fetcher,
  };
  const { policy_digest: pin } = settings;
  const cached = await loadPinnedSource(file, pin, evidence, io.home);
  if (typeof cached === "string") return blocked(cached);
  const { source, warning, state } = cached;
  if (!source) return { digest: pin, evidence, watch, warning, state };
  const compiled = compilePolicies([{ name: file, text: source.text }]);
  if (!compiled.ok) return blocked("the verified policy can't be compiled");
  return {
    document: compiled.document,
    digest: pin,
    evidence,
    watch,
    warning,
    state,
  };
}

const matchesPin = (source: Source, pin: string) =>
  source.digest === pin && hash(source.text) === pin;

async function loadPinnedSource(
  file: string,
  pin: string,
  evidence: RemoteConfig,
  home = homedir(),
) {
  const { url, token, workspaceRevision } = evidence;
  const scope = hash(`${url}\n${token}\n${workspaceRevision}`);
  // Policy refreshes cannot change the work revision that evidence covers.
  const folder = spoolFolder(home, file, "policies");
  const cacheFile = join(folder, "live.json");
  const cache = await readCache(cacheFile, scope, pin, token);
  const pulled = await pullPolicy(evidence, cache, evidence.fetch ?? fetch);
  if (typeof pulled !== "string" && "refusal" in pulled) return pulled.refusal;
  const matches = typeof pulled !== "string" && matchesPin(pulled.source, pin);
  const source = matches ? pulled.source : cache?.source;
  const warning = matches
    ? undefined
    : `Nodrail: using locked policy ${pin}; ${typeof pulled === "string" ? pulled : "live policy differs from the lock"}. Run nodrail plan to review rollout.\n`;
  if (matches && pulled.save)
    await saveCache(cacheFile, {
      scope,
      etag: pulled.etag,
      validator_mac: pulled.etag
        ? validatorMac(token, scope, pin, pulled.etag)
        : undefined,
      source: pulled.source,
    });
  const state = matches && !pulled.offline ? "live" : "cached";
  return { source, warning, state } as const;
}
