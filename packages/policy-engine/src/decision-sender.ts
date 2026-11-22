// The detached sender for decision reporting (`decisions-send`): sends what
// waits in the queue to the control plane, batch by batch, with the host's
// credential. A batch file stays until every decision and outcome in it is
// in or refused, so a failure retries it whole, with the same keys: the
// control plane answers a retried key with the same row.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  reportFile,
  type Queued,
  type QueuedDecision,
  type QueuedOutcome,
} from "./decision-report.ts";
import { secretValue } from "./secret-refs.ts";
import {
  batches,
  countsOf,
  readStatus,
  stillSending,
  writeStatus,
  type Counts,
} from "./telemetry.ts";

/** What one request carries at most: the control plane's limits, with room. */
const MAX_ITEMS = 100;
const MAX_BODY = 60 * 1024;
const SEND_FOR = 20_000;
const SEND_TIMEOUT = 5_000;
/** Keys recorded and their rows, kept for outcomes that come later. */
const KEPT_IDS = 2_000;
const IDS = "ids.json";
const LOCK = "sending";

/** A failure worth trying again later: the network, 5xx, 429, 408. */
class Retry extends Error {}

type Sender = {
  base: string;
  credential: string;
  send: typeof fetch;
  counts: Counts;
  ids: Record<string, string>;
};

async function post(sender: Sender, path: string, body: unknown) {
  let response: Response;
  try {
    response = await sender.send(`${sender.base}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${sender.credential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SEND_TIMEOUT),
      redirect: "error",
    });
  } catch (error) {
    throw new Retry((error as Error).message);
  }
  const json: unknown = await response.json().catch(() => null);
  if (
    response.status >= 500 ||
    response.status === 429 ||
    response.status === 408
  )
    throw new Retry(`The control plane answered ${response.status}`);
  const code = (json as { error?: { code?: unknown } } | null)?.error?.code;
  return {
    ok: response.ok,
    json,
    code: typeof code === "string" ? code : `HTTP_${response.status}`,
  };
}

/** Decisions in requests under the control plane's limits, in order. */
function chunks(decisions: QueuedDecision[]) {
  const out: Record<string, unknown>[][] = [];
  let current: Record<string, unknown>[] = [];
  let size = 0;
  for (const { item } of decisions) {
    const bytes = Buffer.byteLength(JSON.stringify(item)) + 1;
    if (
      current.length &&
      (current.length >= MAX_ITEMS || size + bytes > MAX_BODY)
    ) {
      out.push(current);
      current = [];
      size = 0;
    }
    current.push(item);
    size += bytes;
  }
  if (current.length) out.push(current);
  return out;
}

type Result = {
  key?: unknown;
  action_id?: unknown;
  error?: { code?: unknown };
};

async function sendDecisions(sender: Sender, decisions: QueuedDecision[]) {
  const { counts } = sender;
  for (const chunk of chunks(decisions)) {
    const answer = await post(sender, "/decisions", { decisions: chunk });
    if (!answer.ok) {
      // Refused whole (a credential without the scope, say): never resent.
      counts.rejected += chunk.length;
      counts.lastRejection = answer.code;
      continue;
    }
    const results = (answer.json as { results?: Result[] } | null)?.results;
    chunk.forEach((item, index) => {
      const result = results?.[index];
      if (typeof result?.action_id === "string") {
        sender.ids[item.idempotency_key as string] = result.action_id;
        counts.sent += 1;
      } else if (result?.error) {
        counts.rejected += 1;
        counts.lastRejection = String(result.error.code);
      } else counts.unknown += 1;
    });
  }
}

async function sendOutcomes(sender: Sender, outcomes: QueuedOutcome[]) {
  const { counts } = sender;
  for (const { key, outcome } of outcomes) {
    const id = sender.ids[key];
    // Its decision was refused, or never seen: nothing to report it on.
    if (!id) {
      counts.rejected += 1;
      continue;
    }
    const answer = await post(sender, `/actions/${id}/reports`, {
      report_key: `${key}:outcome`,
      outcome,
    });
    if (answer.ok) counts.sent += 1;
    else {
      counts.rejected += 1;
      counts.lastRejection = answer.code;
    }
  }
}

function readIds(folder: string): Record<string, string> {
  try {
    const kept = JSON.parse(readFileSync(join(folder, IDS), "utf8")) as unknown;
    return typeof kept === "object" && kept !== null
      ? (kept as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

function writeIds(folder: string, ids: Record<string, string>) {
  const entries = Object.entries(ids).slice(-KEPT_IDS);
  writeFileSync(join(folder, IDS), JSON.stringify(Object.fromEntries(entries)));
}

/**
 * One batch file: its decisions first, then the outcomes they answer.
 * Counted only once the whole file is through, so a retry counts nothing
 * twice; the rows it got stay known meanwhile.
 */
async function sendBatch(sender: Sender, path: string) {
  const entries = readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Queued);
  const tally: Sender = {
    ...sender,
    counts: { sent: 0, rejected: 0, unknown: 0 },
  };
  await sendDecisions(
    tally,
    entries.filter(
      (entry): entry is QueuedDecision => entry.type === "decision",
    ),
  );
  await sendOutcomes(
    tally,
    entries.filter((entry): entry is QueuedOutcome => entry.type === "outcome"),
  );
  const { counts } = sender;
  counts.sent += tally.counts.sent;
  counts.rejected += tally.counts.rejected;
  counts.unknown += tally.counts.unknown;
  if (tally.counts.lastRejection)
    counts.lastRejection = tally.counts.lastRejection;
}

/**
 * Sends what waits until the queue is empty, the control plane fails, or
 * time is up; then records how it went and frees the lock. Counts as
 * telemetry's: sent, rejected (never resent), dropped (the queue was full).
 */
export async function sendDecisionQueue(
  folder: string,
  file: string,
  env: Record<string, string | undefined>,
  send: typeof fetch = fetch,
) {
  const until = Date.now() + SEND_FOR;
  const counts = countsOf(readStatus(folder));
  let error: string | undefined;
  const ids = readIds(folder);
  try {
    const config = reportFile.parse(JSON.parse(readFileSync(file, "utf8")));
    const sender: Sender = {
      base: `${config.url.replace(/\/$/, "")}/api/v1/runtime`,
      credential: secretValue(config.credential, env),
      send,
      counts,
      ids,
    };
    let waiting = batches(folder);
    while (waiting.length > 0 && Date.now() < until) {
      for (const name of waiting) {
        await sendBatch(sender, join(folder, name));
        rmSync(join(folder, name), { force: true });
        writeIds(folder, ids);
        stillSending(folder);
      }
      waiting = batches(folder);
    }
  } catch (failure) {
    error = (failure as Error).message;
  } finally {
    writeIds(folder, ids);
    writeStatus(folder, counts, error);
    rmSync(join(folder, LOCK), { force: true });
  }
}
