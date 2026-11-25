// The detached sender for decision reporting (`decisions-send`): sends what
// waits in the queue to the control plane, batch by batch, with the host's
// credential. A batch file stays until every decision and outcome in it is
// in or refused, so a failure retries it whole, with the same keys: the
// control plane answers a retried key with the same row.
import { readHookConnection } from "./hook-connection.ts";
import { hookCredential } from "./hook-credential.ts";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  type Queued,
  type QueuedDecision,
  type QueuedOutcome,
} from "./decision-report.ts";
import { decisionDestination } from "./decision-destination.ts";
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
  includeArguments?: boolean;
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

function redactDecision(item: QueuedDecision["item"]) {
  const { params: _params, resource, reason: _reason, ...safe } = item;
  const kind = (resource as { kind?: unknown } | null)?.kind;
  return { ...safe, params: {}, resource: { kind, id: "redacted" } };
}

/** Keep each recorded step in order with the decisions around it. */
async function sendHistory(sender: Sender, entries: Queued[]) {
  let decisions: QueuedDecision[] = [];
  let digest: unknown;
  for (const entry of entries) {
    if (entry.type === "decision") {
      const item = sender.includeArguments
        ? entry.item
        : redactDecision(entry.item);
      decisions.push({ ...entry, item });
      digest = entry.item.policy_digest;
    }
    if (entry.type !== "step") continue;
    await sendDecisions(sender, decisions);
    decisions = [];
    const answer = await post(sender, "/steps", entry.item);
    if (answer.ok) sender.counts.sent += 1;
    else {
      sender.counts.rejected += 1;
      sender.counts.lastRejection = answer.code;
    }
  }
  await sendDecisions(sender, decisions);
  return digest;
}

function actionsForOutcome(ids: Sender["ids"], key: string) {
  if (ids[key]) return [[key, ids[key]]] as const;
  if (!key.startsWith("copilot:")) return [];
  return Object.entries(ids).filter(([part]) => part.startsWith(`${key}#`));
}

async function sendOutcomes(sender: Sender, outcomes: QueuedOutcome[]) {
  for (const {
    key,
    agent,
    outcome,
    measured,
    tokens,
    settlements,
    cancellation,
  } of outcomes) {
    const body = { outcome, measured, tokens, agent };
    for (const target of settlements ?? [])
      await sendOutcome(sender, "/budgets/settle", {
        call_fingerprint: target.key,
        policy_digest: target.policyDigest,
        ...body,
      });
    if (cancellation) continue;

    const actions = actionsForOutcome(sender.ids, key);
    for (const [part, id] of actions)
      await sendOutcome(sender, `/actions/${id}/reports`, {
        report_key: `${part}:outcome`,
        ...body,
      });
    if (!actions.length && !settlements?.length) sender.counts.rejected += 1;
  }
}

async function sendOutcome(sender: Sender, path: string, body: object) {
  const answer = await post(sender, path, body);
  if (answer.ok) sender.counts.sent += 1;
  else {
    sender.counts.rejected += 1;
    sender.counts.lastRejection = answer.code;
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
  const digest = await sendHistory(tally, entries);
  await sendOutcomes(
    tally,
    entries.filter((entry): entry is QueuedOutcome => entry.type === "outcome"),
  );
  const observation = entries
    .filter((entry) => entry.type === "inventory")
    .at(-1);
  if (observation)
    await post(tally, "/inventory", observation.item).catch(() => undefined);
  if (digest !== undefined)
    await post(tally, "/heartbeat", { policy_digest: digest }).catch(
      () => undefined,
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
    const config = JSON.parse(readFileSync(file, "utf8")) as {
      decide?: string;
    };
    const connected =
      config.decide === "cloud" ||
      (config.decide === undefined && basename(file) === "connect.json");
    const settings = connected ? readHookConnection(file, true) : null;
    const verified =
      settings?.decide === "cloud"
        ? { config: settings, token: await hookCredential(settings, env) }
        : undefined;
    const { url, credential, binding } = decisionDestination(
      file,
      env,
      verified,
    );
    // Unbound queues from older releases and queues for previous connections
    // stay on disk without being sent with the current credential.
    if (basename(folder) !== binding)
      throw new Error(
        "the queued decisions belong to another or unbound destination",
      );
    const sender: Sender = {
      base: `${url}/api/v1/runtime`,
      credential,
      send,
      counts,
      ids,
      includeArguments:
        settings?.decide === "cloud" && settings.report_arguments,
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
