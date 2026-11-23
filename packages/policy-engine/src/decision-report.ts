// Decision reporting to the control plane (R388, M1.3): every call the hook
// decides, and every outcome it sees, goes to Nodrail's `POST
// /runtime/decisions`, so the control plane records it in its runs and
// Activity without deciding it again. The hook never waits on the network:
// it appends the item to a bounded queue in ~/.nodrail and wakes a detached
// sender (decision-sender.ts), exactly as telemetry does. Keys are
// deterministic per call, so a retry is the same row.
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { controlPlaneUrl } from "./connect-schema.ts";
import { secretRef } from "./connections.ts";
import { told, type Observed } from "./hook-telemetry.ts";
import type { PolicyDocument } from "./policies.ts";
import { policyRevision } from "./reporting-spans.ts";
import { enqueue, spoolFolder, startSender, wakeSender } from "./telemetry.ts";

/**
 * The hook's `--report <file>`: where the control plane is and the host's
 * credential (`ndr_…`) by reference. `.nodrail/connect.json` has both, so
 * it can be given as it is; other fields are ignored.
 */
export const reportFile = z.object({
  url: controlPlaneUrl,
  credential: secretRef,
});
export type ReportFile = z.infer<typeof reportFile>;

/** What the queue holds: a decision to record, or what became of one. */
export type QueuedDecision = {
  type: "decision";
  item: Record<string, unknown>;
};
export type QueuedOutcome = {
  type: "outcome";
  key: string;
  outcome: "success" | "failure";
};
export type Queued = QueuedDecision | QueuedOutcome;

const MAX_REASON = 1000;

const text = (value: unknown) =>
  typeof value === "string" && value.length > 0 && value.length <= 200
    ? value
    : null;

/**
 * A call's key, the same at PreToolUse and at its outcome: the host and a
 * hash of the session and the call's id. A call without an id gets a
 * random key; its outcome then can't be matched, and isn't sent.
 */
export function callKey(
  host: string,
  event: { session_id?: unknown; tool_use_id?: unknown } | null,
) {
  const call = text(event?.tool_use_id);
  if (!call) return null;
  const session = text(event?.session_id) ?? "";
  const hash = createHash("sha256")
    .update(`${session}\n${call}`)
    .digest("hex")
    .slice(0, 40);
  return `${host}:${hash}`;
}

/** The name the policy gives a rule, gate or budget, if it has one. */
function nameOf(document: PolicyDocument, id: string) {
  const named = [
    ...document.rules,
    ...("gates" in document ? document.gates : []),
    ...("budgets" in document ? document.budgets : []),
  ] as { id: string; name?: string }[];
  const name = named.find((entry) => entry.id === id)?.name;
  return name && name.length <= 200 ? name : undefined;
}

/** A judged call as the control plane records it, or null when it can't be. */
export function decisionItem(
  observed: Observed,
  input: {
    host: string;
    document: PolicyDocument;
    policyDigest: string | null;
    now?: Date;
  },
): Record<string, unknown> | null {
  const { judged, event, agent, run, step } = observed;
  // A call that couldn't be described (or a guard's refusal before it was)
  // has no action to record; telemetry still counts it.
  if (!judged.action) return null;
  const ruleId = judged.decision?.matchedRuleId ?? null;
  const name = ruleId ? nameOf(input.document, ruleId) : undefined;
  const reason = judged.decision?.explanation;
  return {
    idempotency_key:
      callKey(input.host, event) ?? `${input.host}:${randomUUID()}`,
    ...judged.action,
    verdict: told(judged),
    rule:
      ruleId && ruleId.length <= 128
        ? { id: ruleId, ...(name ? { name } : {}) }
        : null,
    ...(reason ? { reason: reason.slice(0, MAX_REASON) } : {}),
    decided_at: (input.now ?? new Date()).toISOString(),
    policy_digest: input.policyDigest,
    ...(run
      ? {
          run: {
            key: run,
            ...(step && agent ? { step: { id: step, agent } } : {}),
          },
        }
      : {}),
  };
}

/** PostToolUse ran it; PostToolUseFailure says it failed. Else null. */
export function outcomeOf(stdin: string, host: string): QueuedOutcome | null {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(stdin) as Record<string, unknown>;
  } catch {
    return null;
  }
  const name = event.hook_event_name;
  if (name !== "PostToolUse" && name !== "PostToolUseFailure") return null;
  const key = callKey(host, event);
  if (!key) return null;
  return {
    type: "outcome",
    key,
    outcome: name === "PostToolUse" ? "success" : "failure",
  };
}

/** What the hook tells the sink: each decision, and each outcome. */
export type DecisionSink = {
  observe: (observed: Observed) => void;
  outcome: (stdin: string) => void;
};

/**
 * The hook's sink for `--report <file>`, or null when the file can't be
 * read: then reporting is off, with a warning, and the decision stands.
 * Nothing here can change or delay a decision.
 */
export function decisionSink(input: {
  file: string;
  host: string;
  document: PolicyDocument;
  /** The rules the hook was given: one file's SHA-256 is the digest. */
  paths?: readonly string[];
  self: readonly string[];
  warn: (text: string) => void;
  home?: string;
}): DecisionSink | null {
  let folder: string;
  try {
    reportFile.parse(JSON.parse(readFileSync(input.file, "utf8")));
    folder = spoolFolder(input.home ?? homedir(), input.file, "decisions");
  } catch (error) {
    input.warn(
      `Nodrail: decision reporting is off: can't read ${input.file}: ${(error as Error).message}\n`,
    );
    return null;
  }
  const policyDigest = policyRevision(input.paths ?? []);
  const queue = (entry: Queued) => {
    try {
      enqueue(folder, entry);
      wakeSender(folder, () =>
        startSender(input.self, folder, input.file, "decisions-send"),
      );
    } catch (error) {
      input.warn(
        `Nodrail: decision reporting failed: ${(error as Error).message}\n`,
      );
    }
  };
  return {
    observe: (observed) => {
      const item = decisionItem(observed, { ...input, policyDigest });
      if (item) queue({ type: "decision", item });
    },
    outcome: (stdin) => {
      const outcome = outcomeOf(stdin, input.host);
      if (outcome) queue(outcome);
    },
  };
}
