import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { encodeSpans, type SpanRecord } from "./otlp.ts";
import { deliveryOf } from "./otlp-response.ts";
import { secretValue } from "./secret-refs.ts";
import { telemetryFile } from "./telemetry-schema.ts";

/**
 * Nodrail's own signal over OpenTelemetry: one span per decision the hook
 * makes, with the ids the host's own telemetry uses (`session.id`,
 * `gen_ai.tool.call.id`), so any backend joins the two. Only identifiers
 * and the decision leave: never a query, a prompt, an argument or a secret.
 *
 * The hook never waits on the network. It appends the span to a bounded
 * spool and wakes a sender, a separate short-lived process; a receiver that
 * is down only costs spans, counted as dropped, never a decision.
 */

/** The queue holds this much; anything more is dropped and counted. */
const MAX_SPOOL = 512 * 1024;
const MAX_BATCHES = 20;
/** A sender that hasn't touched its lock for this long has stopped. */
const STALE_LOCK = 30_000;
/** After a failure, senders wait this long before trying again. */
const BACKOFF = 30_000;
/** A sender sends for at most this long, then leaves the rest. */
const SEND_FOR = 20_000;
const SEND_TIMEOUT = 5_000;

/** Where the spans for one project's telemetry wait, in the person's home. */
export function spoolFolder(home: string, file: string) {
  // By its real path: hosts name the project folder differently.
  let path = resolve(file);
  try {
    path = realpathSync(path);
  } catch {
    // Not there yet: as written.
  }
  const key = createHash("sha256").update(path).digest("hex");
  return join(home, ".nodrail", "telemetry", key.slice(0, 16));
}

type Event = {
  session_id?: unknown;
  tool_use_id?: unknown;
  tool_name?: unknown;
};

const text = (value: unknown) =>
  typeof value === "string" && value.length > 0 && value.length <= 200
    ? value
    : null;

/** A decision as a span, with the allow-listed attributes only. */
export function decisionSpan(input: {
  event: Event | null;
  host: string;
  agent: string | null;
  action: {
    tool: string;
    operation: string;
    resource: { kind: string };
  } | null;
  /** What the host was told. */
  decision: string;
  /** What the rules said, before the hook's own defaults: none when no rule. */
  matched?: string | null;
  rule: string | null;
  /** Legacy: 16 hex characters of a JSON hash; never compared. */
  revision: string;
  /** Contract v2: the policy file's full SHA-256, when one file. */
  policyRevision?: string | null;
  machine?: string | null;
  /** The run (its hashed key) and step, when the rules keep a ledger. */
  run?: string | null;
  step?: string | null;
  started: bigint;
  ended: bigint;
}): SpanRecord {
  const attributes: Record<string, string> = {
    "nodrail.host": input.host,
    "nodrail.decision": input.decision,
    "nodrail.revision": input.revision,
  };
  const set = (key: string, value: string | null) => {
    if (value !== null) attributes[key] = value;
  };
  set("nodrail.agent", input.agent);
  set("nodrail.tool", input.action?.tool ?? null);
  set("nodrail.operation", input.action?.operation ?? null);
  set("nodrail.resource.kind", input.action?.resource.kind ?? null);
  set("nodrail.match", input.matched ?? null);
  set("nodrail.rule", input.rule);
  set("nodrail.policy.revision", input.policyRevision ?? null);
  set("nodrail.machine", input.machine ?? null);
  set("nodrail.run", input.run ?? null);
  set("nodrail.step", input.step ?? null);
  const session = text(input.event?.session_id);
  set("session.id", session);
  set("gen_ai.conversation.id", session);
  set("gen_ai.tool.call.id", text(input.event?.tool_use_id));
  set("gen_ai.tool.name", text(input.event?.tool_name));
  return {
    traceId: randomBytes(16).toString("hex"),
    spanId: randomBytes(8).toString("hex"),
    name: "nodrail.decision",
    start: input.started.toString(),
    end: input.ended.toString(),
    attributes,
  };
}

const SPOOL = "spool.jsonl";
const DROPPED = "dropped";
const LOCK = "sending";
const STATUS = "status.json";

/** Adds the span to the queue, or counts it as dropped when the queue is full. */
export function enqueue(folder: string, span: SpanRecord) {
  mkdirSync(folder, { recursive: true });
  const line = `${JSON.stringify(span)}\n`;
  let size = 0;
  try {
    size = statSync(join(folder, SPOOL)).size;
  } catch {
    // No queue yet.
  }
  if (size + line.length > MAX_SPOOL)
    appendFileSync(join(folder, DROPPED), "x");
  else appendFileSync(join(folder, SPOOL), line);
}

export type TelemetryStatus = {
  state: "ok" | "degraded";
  at: string;
  /** Spans the receiver kept. */
  sent: number;
  /** Spans never sent: the queue was full or too many batches waited. */
  dropped: number;
  /** Spans the receiver refused; never sent again. */
  rejected?: number;
  /** Spans sent whose answer couldn't be read: kept or not, unknown. */
  unknown?: number;
  /** The receiver's last word on what it refused, if any. */
  lastRejection?: string;
  error?: string;
  /** Senders wait until then after a failure. */
  retryAfter?: number;
};

export function readStatus(folder: string): TelemetryStatus | null {
  try {
    return JSON.parse(
      readFileSync(join(folder, STATUS), "utf8"),
    ) as TelemetryStatus;
  } catch {
    return null;
  }
}

const droppedCount = (folder: string) => {
  try {
    return statSync(join(folder, DROPPED)).size;
  } catch {
    return 0;
  }
};

/**
 * Starts a sender unless one is at work or the last failure is too recent.
 * The lock is a file only one process can create; a stale one is taken over.
 */
export function wakeSender(
  folder: string,
  start: () => void,
  now = Date.now(),
) {
  const status = readStatus(folder);
  if (status?.retryAfter && now < status.retryAfter) return false;
  const lock = join(folder, LOCK);
  if (!takeLock(lock, now)) return false;
  try {
    start();
  } catch (error) {
    // A sender that never started holds nothing.
    rmSync(lock, { force: true });
    throw error;
  }
  return true;
}

/** Creates the lock, or takes over one left by a sender that stopped. */
function takeLock(lock: string, now: number) {
  for (let attempt = 0; attempt < 2; attempt++)
    try {
      writeFileSync(lock, String(process.pid), { flag: "wx" });
      return true;
    } catch {
      try {
        if (now - statSync(lock).mtimeMs < STALE_LOCK) return false;
        unlinkSync(lock);
      } catch {
        return false;
      }
    }
  return false;
}

/** Runs this command line again as a detached sender for the folder. */
export function startSender(
  self: readonly string[],
  folder: string,
  file: string,
) {
  const child = spawn(
    process.execPath,
    [...self, "telemetry-send", folder, file],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
}

/** The batches waiting, oldest first; the newest spans become one more. */
function batches(folder: string) {
  try {
    renameSync(
      join(folder, SPOOL),
      join(folder, `batch-${Date.now()}-${process.pid}.jsonl`),
    );
  } catch {
    // Nothing new.
  }
  const waiting = readdirSync(folder)
    .filter((name) => name.startsWith("batch-"))
    .sort();
  // Too many waiting: the oldest go, counted.
  for (const name of waiting.splice(
    0,
    Math.max(0, waiting.length - MAX_BATCHES),
  )) {
    const lines = readFileSync(join(folder, name), "utf8")
      .split("\n")
      .filter(Boolean);
    appendFileSync(join(folder, DROPPED), "x".repeat(lines.length));
    rmSync(join(folder, name), { force: true });
  }
  return waiting;
}

/**
 * Sends what waits, batch by batch, until the queue is empty, the receiver
 * fails, or time is up; then records how it went and frees the lock.
 */
export async function sendSpool(
  folder: string,
  file: string,
  env: Record<string, string | undefined>,
  send: typeof fetch = fetch,
) {
  const config = telemetryFile.parse(JSON.parse(readFileSync(file, "utf8")));
  const until = Date.now() + SEND_FOR;
  const counts = countsOf(readStatus(folder));
  let error: string | undefined;
  try {
    const headers = exportHeaders(config, env);
    const resource = resourceOf(config);
    let waiting = batches(folder);
    while (waiting.length > 0 && Date.now() < until) {
      for (const name of waiting) {
        const path = join(folder, name);
        const spans = readFileSync(path, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as SpanRecord);
        const { body, contentType } = encodeSpans(
          spans,
          resource,
          config.traces.protocol,
        );
        const delivery = await deliveryOf(
          await send(config.traces.endpoint, {
            method: "POST",
            headers: { ...headers, "content-type": contentType },
            body,
            signal: AbortSignal.timeout(SEND_TIMEOUT),
          }),
          spans.length,
        );
        // Kept for a retry with the same span ids; nothing else is resent.
        if (delivery.kind === "retry") throw new Error(delivery.reason);
        rmSync(path, { force: true });
        counts.sent += delivery.accepted;
        counts.rejected += delivery.rejected;
        counts.unknown += delivery.unknown;
        if (delivery.message) counts.lastRejection = delivery.message;
        stillSending(folder);
      }
      waiting = batches(folder);
    }
  } catch (failure) {
    error = (failure as Error).message;
  } finally {
    writeStatus(folder, counts, error);
    rmSync(join(folder, LOCK), { force: true });
  }
}

/** Keeps the lock fresh, so no other sender takes over; never fails a send. */
function stillSending(folder: string) {
  try {
    utimesSync(join(folder, LOCK), new Date(), new Date());
  } catch {
    // Run without the lock (by hand, or a test): nothing to keep fresh.
  }
}

/** The schema the spans follow (reporting contract v2). */
export const REPORTING_SCHEMA = "2";

type TelemetryConfig = ReturnType<typeof telemetryFile.parse>;

/** Who sends: the schema, and the project by name and by stable id. */
const resourceOf = (config: TelemetryConfig): Record<string, string> => ({
  "service.name": "nodrail",
  "nodrail.schema": REPORTING_SCHEMA,
  "nodrail.project": config.project,
  ...(config.projectId ? { "nodrail.project.id": config.projectId } : {}),
});

type Counts = Required<
  Pick<TelemetryStatus, "sent" | "rejected" | "unknown">
> & { lastRejection?: string };

const countsOf = (status: TelemetryStatus | null): Counts => ({
  sent: status?.sent ?? 0,
  rejected: status?.rejected ?? 0,
  unknown: status?.unknown ?? 0,
  ...(status?.lastRejection ? { lastRejection: status.lastRejection } : {}),
});

/** The export's headers: the bearer token, and any written ones. */
function exportHeaders(
  config: TelemetryConfig,
  env: Record<string, string | undefined>,
) {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(config.traces.headers))
    headers[name] = typeof value === "string" ? value : secretValue(value, env);
  if (config.traces.bearer)
    headers.authorization = `Bearer ${secretValue(config.traces.bearer, env)}`;
  return headers;
}

function writeStatus(
  folder: string,
  counts: Counts,
  error: string | undefined,
) {
  const lost = counts.rejected > 0 || counts.unknown > 0;
  const status: TelemetryStatus = {
    state: error || lost ? "degraded" : "ok",
    at: new Date().toISOString(),
    ...counts,
    dropped: droppedCount(folder),
    ...(error ? { error, retryAfter: Date.now() + BACKOFF } : {}),
  };
  writeFileSync(join(folder, STATUS), `${JSON.stringify(status)}\n`);
}

/** The project's name, as the spans carry it: its folder's name. */
export const projectName = (root: string) => basename(resolve(root));

/** The telemetry file's project folder: the one holding `.nodrail`. */
export const telemetryRoot = (file: string) => dirname(dirname(resolve(file)));
