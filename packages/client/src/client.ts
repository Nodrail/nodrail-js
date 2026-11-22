// The runtime API client: one installation talking to Cloud. Kept apart
// from the SDK so the hook bundles only this and what it needs.
import { randomBytes } from "node:crypto";
import {
  type ActionDescriptor,
  type ActionStatus,
  type PermitAllow,
  type ReportOutcome,
} from "./protocol.ts";
import {
  alreadyIn,
  Blocked,
  defaultSleep,
  refusedNewFields,
  transient,
  REPORT_RETRY_MS,
} from "./errors.ts";
import { checkMeasured, type Measured } from "./subject.ts";

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

/** What `GET /runtime/policy` answers. */
export type LivePolicy = {
  policy_revision: number;
  published_at: string | null;
  managed: {
    project_id: string;
    revision: string;
    policy_revision: string | null;
  } | null;
  source: { digest: string; text: string } | null;
};

/** A call the hook decided on its host, as `POST /runtime/decisions` takes it. */
export type HostDecision = ActionDescriptor & {
  /** Deterministic per call on the host, so a retry is the same row. */
  idempotency_key: string;
  verdict: "allow" | "deny";
  rule?: { id: string; name?: string } | null;
  reason?: string;
  /** ISO 8601, the host's clock. */
  decided_at: string;
  /** The SHA-256 (hex) of the policy file it decided with, or null. */
  policy_digest: string | null;
  run?: RunRef & { subject?: string | null };
  adapter_version?: string;
};

/** One item's answer: its row, or the code it was refused with. */
export type HostDecisionResult =
  | { key: string; action_id: string }
  | { key: string | null; error: { code: string } };

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
    throw new Blocked(
      typeof error === "string" ? error : "UNAVAILABLE",
      null,
      null,
      response.status,
    );
  }

  heartbeat() {
    return this.request("/heartbeat", {
      body: { adapter_version: this.options.adapterVersion },
    });
  }

  /**
   * The live policy of this credential's environment (`policy:read`): its
   * revision, the project and lock it came from, and the file it was
   * published from with its SHA-256, null when it was made on screen. A
   * host compares the digest with its own lock's.
   */
  async policy(): Promise<LivePolicy> {
    return (await this.request("/policy")) as LivePolicy;
  }

  /**
   * The run is context for the decision; it is not part of the digest. With
   * a run, `subject` is the work revision it is at (null: unknown), which a
   * gate on the revision checks evidence against.
   */
  async submit(
    descriptor: ActionDescriptor,
    idempotencyKey: string,
    run?: RunRef,
    subject?: string | null,
  ) {
    const send = (withSubject: boolean) =>
      this.request("/actions", {
        body: {
          ...descriptor,
          ...(run
            ? { run: withSubject ? { ...run, subject: subject ?? null } : run }
            : {}),
          adapter_version: this.options.adapterVersion,
        },
        headers: { "idempotency-key": idempotencyKey },
      });
    const withSubject = run !== undefined && subject !== undefined;
    return asStatus(await this.compatible(send, withSubject));
  }

  /** Sends with the Wave 3 fields, and once without them to a server that refuses them. */
  private async compatible(
    send: (withNew: boolean) => Promise<unknown>,
    withNew: boolean,
  ) {
    if (!withNew) return send(false);
    try {
      return await send(true);
    } catch (error) {
      if (!refusedNewFields(error)) throw error;
      return send(false);
    }
  }

  /**
   * Calls the hook decided on this host (`decisions:write`), for Nodrail to
   * record in their runs and Activity; it never decides them again. At most
   * 100 per call. Each answer, in order, is the row's id or why that item
   * wasn't recorded; a retry with the same keys answers the same rows.
   */
  async decisions(
    batch: readonly HostDecision[],
  ): Promise<HostDecisionResult[]> {
    const body = await this.request("/decisions", {
      body: { decisions: batch },
    });
    if (!isRecord(body) || !Array.isArray(body.results))
      throw new Blocked("INVALID_RESPONSE");
    return body.results as HostDecisionResult[];
  }

  /** A step of a run starting or finishing. Grants nothing by itself. */
  step(event: StepEvent) {
    return this.request("/steps", { body: event });
  }

  async findByKey(idempotencyKey: string) {
    return asStatus(
      await this.request(
        `/actions?idempotency_key=${encodeURIComponent(idempotencyKey)}`,
      ),
    );
  }

  /**
   * Verifies the answer is fresh and exactly for this call before trusting
   * it. `subject`: the work revision at permit time (null: unknown), sent
   * again because the work may have changed since the call was submitted.
   */
  async permit(
    action: ActionStatus,
    subject?: string | null,
  ): Promise<PermitAllow> {
    const nonce = randomBytes(24).toString("hex");
    const startedAt = Date.now();
    const body = await this.compatible(
      (withSubject) =>
        this.request(`/actions/${action.action_id}/permit`, {
          body: {
            action_digest: action.action_digest,
            nonce,
            ...(withSubject ? { subject: subject ?? null } : {}),
          },
        }),
      subject !== undefined,
    );
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
   * What happened to an action. `key` makes it idempotent: a transient
   * failure is sent again with the same key a bounded number of times, and
   * a key the server already has means the report is in. `measured`: the
   * amounts the result measured, for budgets that sum them; refused whole
   * when any is unusable (see checkMeasured).
   */
  async report(
    actionId: string,
    report: {
      key: string;
      outcome: ReportOutcome;
      permitId?: string | null;
      details?: object;
      measured?: readonly Measured[];
    },
    options: { sleep?: (ms: number) => Promise<void> } = {},
  ): Promise<unknown> {
    const measured =
      report.measured === undefined
        ? undefined
        : checkMeasured(report.measured);
    if (measured === null)
      throw new TypeError(
        "Nodrail: measured takes result. paths with whole, non-negative amounts, each path once.",
      );
    const send = (withMeasured: boolean) =>
      this.request(`/actions/${actionId}/reports`, {
        body: {
          report_key: report.key,
          outcome: report.outcome,
          ...(report.permitId ? { permit_id: report.permitId } : {}),
          ...(report.details ? { details: report.details } : {}),
          ...(withMeasured && measured ? { measured } : {}),
        },
      });
    const sleep = options.sleep ?? defaultSleep;
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.compatible(send, Boolean(measured?.length));
      } catch (error) {
        if (alreadyIn(error)) return { recorded: true };
        const pause = REPORT_RETRY_MS[attempt];
        if (!transient(error) || pause === undefined) throw error;
        await sleep(pause);
      }
    }
  }
}
