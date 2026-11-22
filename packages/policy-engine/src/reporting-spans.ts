// What the hook reports besides decisions (reporting contract v2): a run's
// steps and actions, as the run ledger records them, and the machine they
// come from. Counts and names only: never a finding's text, an argument or
// anything a person or agent wrote.
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SpanRecord } from "./otlp.ts";
import type { RunEvent } from "./runs.ts";

/**
 * This machine, to a team view: a random id kept in the home folder, made
 * once. Never the hostname or anything that says who or where.
 */
export function machineId(home: string) {
  const file = join(home, ".nodrail", "machine-id");
  try {
    const kept = readFileSync(file, "utf8").trim();
    if (/^[0-9a-f]{32}$/.test(kept)) return kept;
  } catch {
    // Not made yet.
  }
  const made = randomBytes(16).toString("hex");
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, `${made}\n`, { mode: 0o600 });
  return made;
}

/** The policy file's full SHA-256, the same digest the lock records. */
export function policyRevision(paths: readonly string[]) {
  if (paths.length !== 1) return null;
  try {
    return createHash("sha256").update(readFileSync(paths[0]!)).digest("hex");
  } catch {
    // A folder of rules: no single file to name.
    return null;
  }
}

/** A run as reports name it: a hash of the ledger's key. */
export const runRef = (run: string) =>
  createHash("sha256").update(run).digest("hex").slice(0, 32);

const nanos = (iso: string) =>
  (BigInt(Date.parse(iso)) * 1_000_000n).toString();

/** A run's step or action, as the ledger recorded it. */
export function runEventSpan(input: {
  run: string;
  event: RunEvent;
  host: string;
  machine: string;
}): SpanRecord {
  const { event } = input;
  const attributes: Record<string, string> = {
    "nodrail.machine": input.machine,
    "nodrail.host": input.host,
    // The ledger's key can name a repository and branch: only its hash leaves.
    "nodrail.run": runRef(input.run),
    "nodrail.run.event": event.type,
    "nodrail.agent": event.agent,
  };
  if (event.step) attributes["nodrail.step"] = event.step;
  if (event.type === "step.finished") {
    if (event.verdict) attributes["nodrail.verdict"] = event.verdict;
    // A contract's count is the runtime's; past what Cloud takes, it is left out, not clamped.
    const findings = event.receipt?.findings ?? event.findings.length;
    if (findings <= 1000) attributes["nodrail.findings"] = String(findings);
    // A contract receipt's state and digest; its values never leave here.
    if (event.receipt) {
      attributes["nodrail.receipt.state"] = event.receipt.state;
      attributes["nodrail.receipt.contract"] = event.receipt.contract;
    }
    if (event.usage.tokens !== undefined)
      attributes["nodrail.usage.tokens"] = String(event.usage.tokens);
    if (event.usage.usd !== undefined)
      attributes["nodrail.usage.usd"] = String(event.usage.usd);
  }
  if (event.type === "action") {
    attributes["nodrail.tool"] = event.tool;
    attributes["nodrail.operation"] = event.operation;
    attributes["nodrail.outcome"] = event.outcome;
    attributes["nodrail.change"] = String(event.change === true);
  }
  if (event.type === "connection.call") {
    // States, digests and the execution only: never a value.
    const { call } = event;
    attributes["nodrail.tool"] = call.connection;
    attributes["nodrail.operation"] = call.operation;
    attributes["nodrail.execution"] = call.execution;
    attributes["nodrail.delivered"] = String(call.delivered);
    for (const [side, check] of [
      ["input", call.input],
      ["result", call.result],
    ] as const)
      if (check) {
        attributes[`nodrail.${side}.state`] = check.state;
        attributes[`nodrail.${side}.contract`] = check.contract;
      }
  }
  const at = nanos(event.at);
  return {
    traceId: randomBytes(16).toString("hex"),
    spanId: randomBytes(8).toString("hex"),
    name: "nodrail.run.event",
    start: at,
    end: at,
    attributes,
  };
}
