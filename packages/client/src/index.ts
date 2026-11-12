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
export { receiptOf, type ReadReceipt, type StepOptions } from "./runs.ts";

export type ClientOptions = {
  url: string;
  credential: string;
  adapterVersion?: string;
  /** Per request. Exceeding it blocks the call. */
  timeoutMs?: number;
  fetch?: typeof fetch;
};

/** The piece of work a call belongs to, and the step taking it, if any. */
export type RunRef = {
  key: string;
  step?: { id: string; agent: string };
};

/** What an agent ends its step with: as read, or the receipt block as written. */
export type StepReceipt =
  | {
      verdict: string | null;
      findings: string[];
      usage: { tokens?: number; usd?: number };
    }
  | { text: string };

export type StepEvent = {
  run: { key: string };
  step: { id: string; agent: string };
  event: "started" | "finished";
  receipt?: StepReceipt;
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
    init: {
      body?: object;
      headers?: Record<string, string>;
      timeoutMs?: number;
    } = {},
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
        signal: AbortSignal.timeout(init.timeoutMs ?? this.timeoutMs),
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

  /** The run is context for the decision; it is not part of the digest. */
  async submit(
    descriptor: ActionDescriptor,
    idempotencyKey: string,
    run?: RunRef,
  ) {
    return asStatus(
      await this.request("/actions", {
        body: {
          ...descriptor,
          ...(run ? { run } : {}),
          adapter_version: this.options.adapterVersion,
        },
        headers: { "idempotency-key": idempotencyKey },
      }),
    );
  }

  /** A step of a run starting or finishing. Grants nothing by itself. */
  step(event: StepEvent) {
    return this.request("/steps", { body: event });
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

  /**
   * Takes back a request nobody has decided, so no one approves a call that
   * will never run. It never allows anything; a repeat changes nothing.
   */
  async withdraw(actionId: string, options: { timeoutMs?: number } = {}) {
    return asStatus(
      await this.request(`/actions/${actionId}/withdraw`, {
        body: {},
        timeoutMs: options.timeoutMs,
      }),
    );
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
  /** The run this call belongs to, so gates and budgets can see its history. */
  run?: RunRef;
  /** Stops waiting for a person early, as if `waitMs` had passed. */
  signal?: AbortSignal;
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

/** How long giving up may take: the block never waits on Cloud for longer. */
export const WITHDRAW_TIMEOUT_MS = 3000;

/** Best effort: whatever happens, the caller gets the same block. */
async function withdrawQuietly(client: NodrailClient, actionId: string) {
  try {
    await client.withdraw(actionId, { timeoutMs: WITHDRAW_TIMEOUT_MS });
  } catch {
    // A request left open expires on its own; it can never become an allow.
  }
}

/** A pause between checks that ends at once when the caller stops waiting. */
async function pause(
  ms: number,
  sleep: AuthorizeOptions["sleep"],
  signal?: AbortSignal,
) {
  const slept = (sleep ?? defaultSleep)(ms);
  if (!signal) return slept;
  let stop = () => {};
  const stopped = new Promise<void>((done) => {
    stop = done;
    if (signal.aborted) done();
    else signal.addEventListener("abort", stop, { once: true });
  });
  try {
    await Promise.race([slept, stopped]);
  } finally {
    signal.removeEventListener("abort", stop);
  }
}

/**
 * Polls until a person decides. Giving up after waiting takes the request
 * back; with `waitMs: 0` it stays open, for a caller that comes back later.
 */
async function waitForPerson(
  client: NodrailClient,
  descriptor: ActionDescriptor,
  submitted: ActionStatus,
  { waitMs = 0, pollMs = 2000, sleep, signal }: AuthorizeOptions,
): Promise<ActionStatus> {
  let status = submitted;
  const deadline = Date.now() + waitMs;
  while (waiting.has(status.code)) {
    if (Date.now() >= deadline || signal?.aborted) {
      if (waitMs > 0) await withdrawQuietly(client, status.action_id);
      throw new Blocked(status.code, status.reference, status.reason);
    }
    await pause(pollMs, sleep, signal);
    if (signal?.aborted) continue;
    status = await client.status(status.action_id);
    assertSameCall(status, descriptor);
  }
  return status;
}

async function resolve(
  client: NodrailClient,
  descriptor: ActionDescriptor,
  key: string,
  options: AuthorizeOptions,
): Promise<Decision> {
  if (!isPlainJson(descriptor.params)) throw new Blocked("INVALID_ACTION");
  const submitted = await client.submit(descriptor, key, options.run);
  assertSameCall(submitted, descriptor);

  const status = await waitForPerson(client, descriptor, submitted, options);
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
