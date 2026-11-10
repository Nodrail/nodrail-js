import { randomBytes } from "node:crypto";
import {
  actionDigest,
  descriptorDigest,
  isPlainJson,
  type ActionDescriptor,
  type ActionStatus,
  type PermitAllow,
  type ReportOutcome,
} from "./protocol.ts";

export type { ActionDescriptor } from "./protocol.ts";
export {
  createNodrail,
  guard,
  guardMcpServer,
  Nodrail,
  NodrailBlockedError,
  type ActionInput,
  type Describe,
  type Guarded,
  type McpServerLike,
  type GuardedFunction,
  type GuardOptions,
  type NodrailOptions,
  type OnBlocked,
} from "./sdk.ts";

export type ClientOptions = {
  url: string;
  credential: string;
  adapterVersion?: string;
  /** Per request. Exceeding it blocks the call. */
  timeoutMs?: number;
  fetch?: typeof fetch;
};

export type Decision =
  | { allowed: true; actionId: string; permitId: string }
  | {
      allowed: false;
      code: string;
      reason: string | null;
      reference: string | null;
    };

class Blocked extends Error {
  constructor(
    readonly code: string,
    readonly reference: string | null = null,
    readonly reason: string | null = null,
  ) {
    super(code);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringFields = (value: Record<string, unknown>, names: string[]) =>
  names.every((name) => typeof value[name] === "string");

function asStatus(body: unknown): ActionStatus {
  if (
    !isRecord(body) ||
    !stringFields(body, [
      "code",
      "action_id",
      "installation_id",
      "descriptor_digest",
      "action_digest",
      "reference",
    ])
  )
    throw new Blocked("INVALID_RESPONSE");
  return body as ActionStatus;
}

/**
 * HTTPS, or plain HTTP to this machine only, which local development needs.
 * Anything else would send the credential where others can read it.
 */
export function isSafeUrl(url: string) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:") return true;
  if (parsed.protocol !== "http:") return false;
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(host)
  );
}

export class NodrailClient {
  private readonly base: string;
  private readonly timeoutMs: number;
  private readonly send: typeof fetch;

  private readonly secure: boolean;

  constructor(private readonly options: ClientOptions) {
    this.base = `${options.url.replace(/\/$/, "")}/api/v1/runtime`;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.send = options.fetch ?? fetch;
    this.secure = isSafeUrl(options.url);
  }

  private async request(
    path: string,
    init: { body?: object; headers?: Record<string, string> } = {},
  ): Promise<unknown> {
    // The credential never travels in the clear.
    if (!this.secure) throw new Blocked("INSECURE_URL");
    let response: Response;
    try {
      response = await this.send(`${this.base}${path}`, {
        method: init.body ? "POST" : "GET",
        headers: {
          authorization: `Bearer ${this.options.credential}`,
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...init.headers,
        },
        body: init.body ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: "error",
      });
    } catch {
      throw new Blocked("UNAVAILABLE");
    }
    const body: unknown = await response.json().catch(() => null);
    if (response.ok) return body;
    const error =
      isRecord(body) && isRecord(body.error) ? body.error.code : null;
    throw new Blocked(typeof error === "string" ? error : "UNAVAILABLE");
  }

  heartbeat() {
    return this.request("/heartbeat", {
      body: { adapter_version: this.options.adapterVersion },
    });
  }

  async submit(descriptor: ActionDescriptor, idempotencyKey: string) {
    return asStatus(
      await this.request("/actions", {
        body: { ...descriptor, adapter_version: this.options.adapterVersion },
        headers: { "idempotency-key": idempotencyKey },
      }),
    );
  }

  async status(actionId: string) {
    return asStatus(await this.request(`/actions/${actionId}`));
  }

  async findByKey(idempotencyKey: string) {
    return asStatus(
      await this.request(
        `/actions?idempotency_key=${encodeURIComponent(idempotencyKey)}`,
      ),
    );
  }

  /** Verifies the answer is fresh and exactly for this call before trusting it. */
  async permit(action: ActionStatus): Promise<PermitAllow> {
    const nonce = randomBytes(24).toString("hex");
    const startedAt = Date.now();
    const body = await this.request(`/actions/${action.action_id}/permit`, {
      body: { action_digest: action.action_digest, nonce },
    });
    if (!isRecord(body) || body.code !== "ALLOW")
      throw new Blocked(
        isRecord(body) && typeof body.code === "string"
          ? body.code
          : "INVALID_RESPONSE",
        action.reference,
        isRecord(body) && typeof body.reason === "string" ? body.reason : null,
      );
    if (
      !stringFields(body, ["permit_id", "issued_at", "expires_at"]) ||
      body.action_id !== action.action_id ||
      body.action_digest !== action.action_digest ||
      body.installation_id !== action.installation_id ||
      body.claim_nonce !== nonce
    )
      throw new Blocked("PERMIT_MISMATCH", action.reference);
    // Compares durations, so a wrong local clock cannot extend a permit.
    const lifetime =
      Date.parse(body.expires_at as string) -
      Date.parse(body.issued_at as string);
    if (
      !(lifetime > 0) ||
      lifetime > 60_000 ||
      Date.now() - startedAt >= lifetime
    )
      throw new Blocked("PERMIT_STALE", action.reference);
    return body as PermitAllow;
  }

  report(
    actionId: string,
    report: {
      key: string;
      outcome: ReportOutcome;
      permitId?: string | null;
      details?: object;
    },
  ) {
    return this.request(`/actions/${actionId}/reports`, {
      body: {
        report_key: report.key,
        outcome: report.outcome,
        ...(report.permitId ? { permit_id: report.permitId } : {}),
        ...(report.details ? { details: report.details } : {}),
      },
    });
  }
}

export type AuthorizeOptions = {
  /** How long to wait for a person before giving up and blocking. */
  waitMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Checks the server described the very call that is about to be made. */
function assertSameCall(status: ActionStatus, descriptor: ActionDescriptor) {
  const digest = descriptorDigest(status.installation_id, descriptor);
  if (
    status.descriptor_digest !== digest ||
    status.action_digest !== actionDigest(status.action_id, digest)
  )
    throw new Blocked("DIGEST_MISMATCH", status.reference);
}

const waiting = new Set(["APPROVAL_PENDING", "UNKNOWN_PERMISSION_BLOCKED"]);

async function resolve(
  client: NodrailClient,
  descriptor: ActionDescriptor,
  key: string,
  { waitMs = 0, pollMs = 2000, sleep = defaultSleep }: AuthorizeOptions,
): Promise<Decision> {
  if (!isPlainJson(descriptor.params)) throw new Blocked("INVALID_ACTION");
  let status = await client.submit(descriptor, key);
  assertSameCall(status, descriptor);

  const deadline = Date.now() + waitMs;
  while (waiting.has(status.code)) {
    if (Date.now() >= deadline)
      throw new Blocked(status.code, status.reference, status.reason);
    await sleep(pollMs);
    status = await client.status(status.action_id);
    assertSameCall(status, descriptor);
  }
  if (status.code !== "READY")
    throw new Blocked(status.code, status.reference, status.reason);

  const permit = await client.permit(status);
  return {
    allowed: true,
    actionId: permit.action_id,
    permitId: permit.permit_id,
  };
}

/**
 * The only way a governed call should be cleared. It runs only on
 * `allowed: true`; a timeout, an error, or anything unexpected is a block.
 */
export async function authorize(
  client: NodrailClient,
  descriptor: ActionDescriptor,
  key: string,
  options: AuthorizeOptions = {},
): Promise<Decision> {
  try {
    return await resolve(client, descriptor, key, options);
  } catch (error) {
    return error instanceof Blocked
      ? {
          allowed: false,
          code: error.code,
          reason: error.reason,
          reference: error.reference,
        }
      : { allowed: false, code: "CLIENT_ERROR", reason: null, reference: null };
  }
}
