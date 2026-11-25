// Decision reporting to the control plane: every call the hook
// decides, and every outcome it sees, goes to Nodrail's `POST
// /runtime/decisions`, so the control plane records it in its runs and
// Activity without deciding it again. The hook never waits on the network:
// it appends the item to a bounded queue in ~/.nodrail and wakes a detached
// sender (decision-sender.ts), exactly as telemetry does. Keys are
// deterministic per call, so a retry is the same row.
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import {
  forgetClaims,
  readClaims,
  rememberClaims,
  settlementTargets,
  type SettlementTarget,
  type SharedBudgetClaim,
} from "./budget-claims.ts";
import {
  decisionDestination,
  decisionFolder,
  type DecisionTarget,
  type VerifiedReport,
} from "./decision-destination.ts";
import { told, type HookReporting, type Observed } from "./hook-telemetry.ts";
import { receiptText } from "./hook-runs.ts";
import { parseEvent, type StepReport } from "./local-hook.ts";
import type { RunEvent } from "./runs.ts";
import { limitsOf, type PolicyDocument } from "./policies.ts";
import {
  readOutcomeFields,
  remoteReadings,
  sharedLimitsForOutcome,
  type OutcomeTool,
} from "./outcome-readings.ts";
import { policyRevision } from "./reporting-spans.ts";
import { enqueue, startSender, wakeSender } from "./telemetry.ts";

/** What the queue holds: a decision to record, or what became of one. */
export type QueuedDecision = {
  type: "decision";
  item: Record<string, unknown>;
};
export type QueuedOutcome = {
  type: "outcome";
  key: string;
  outcome: "success" | "failure" | "unknown";
  measured?: { path: string; value: number }[];
  tokens?: number;
  settlements?: SettlementTarget[];
  cancellation?: true;
};
export type QueuedStep = { type: "step"; item: Record<string, unknown> };
export type Queued = QueuedDecision | QueuedOutcome | QueuedStep;

function stepItem(run: string, event: RunEvent, details?: StepReport) {
  if (event.type !== "step.started" && event.type !== "step.finished")
    return null;
  const item = {
    run: { key: run },
    step: { id: event.step, agent: event.agent },
  };
  if (event.type === "step.started") return { ...item, event: "started" };
  const text = details?.message
    ? receiptText(details.message, event.agent)
    : null;
  return {
    ...item,
    event: "finished",
    via: details?.via,
    ...(text ? { receipt: { text } } : {}),
  };
}

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
  event: {
    session_id?: unknown;
    tool_use_id?: unknown;
    nodrail_call_part?: unknown;
  } | null,
) {
  const part =
    host === "copilot"
      ? (event?.nodrail_call_part as
          { id?: unknown; index?: unknown } | undefined)
      : undefined;
  const call = text(part?.id ?? event?.tool_use_id);
  if (!call) return null;
  const session = text(event?.session_id) ?? "";
  const hash = createHash("sha256")
    .update(`${session}\n${call}`)
    .digest("hex")
    .slice(0, 40);
  const suffix =
    part &&
    typeof part.index === "number" &&
    Number.isSafeInteger(part.index) &&
    part.index >= 0
      ? `#${part.index}`
      : "";
  return `${host}:${hash}${suffix}`;
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

function reportedRule(document: PolicyDocument, id: string | null) {
  if (!id || id.length > 128) return null;
  const name = nameOf(document, id);
  return name ? { id, name } : { id };
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
  // A call that couldn't be safely described has no action to record.
  if (!judged.action) return null;
  const ruleId = judged.decision?.matchedRuleId ?? null;
  const reason = judged.refusal ?? judged.decision?.explanation;
  return {
    idempotency_key:
      callKey(input.host, event) ?? `${input.host}:${randomUUID()}`,
    ...judged.action,
    verdict: told(judged),
    rule: reportedRule(input.document, ruleId),
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
export function outcomeOf(
  stdin: string,
  host: string,
  document?: PolicyDocument,
  tool: OutcomeTool = {},
): QueuedOutcome | null {
  return outcomeFor(parseEvent(stdin), host, document, tool);
}

function outcomeFor(
  event: Record<string, unknown> | null,
  host: string,
  document?: PolicyDocument,
  tool: OutcomeTool = {},
): QueuedOutcome | null {
  const name = event?.hook_event_name;
  if (name !== "PostToolUse" && name !== "PostToolUseFailure") return null;
  if (!event) return null;
  const key = callKey(host, event);
  if (!key) return null;
  const limits = document ? limitsOf(document) : [];
  const success = name === "PostToolUse";
  const shared = limits.some(({ across }) => across === "environment");
  return {
    type: "outcome",
    key,
    outcome: success ? "success" : shared ? "unknown" : "failure",
    ...(success
      ? remoteReadings(event, sharedLimitsForOutcome(event, limits, tool))
      : {}),
  };
}

/** What the hook tells the sink: each decision, and each outcome. */
export type DecisionSink = {
  destination: DecisionTarget;
  observe: (observed: Observed) => void;
  outcome: (stdin: string) => void;
  step: (run: string, event: RunEvent, details?: StepReport) => void;
  remember: (claims: readonly SharedBudgetClaim[]) => () => void;
  cancel: (claims: readonly SharedBudgetClaim[]) => void;
};

/**
 * The hook's sink for a bound destination, or null with a warning when
 * reporting cannot be configured. The decision still stands.
 * Nothing here can change or delay a decision.
 */
type SinkInput = HookReporting & {
  env?: Record<string, string | undefined>;
  verified?: VerifiedReport;
  tool?: OutcomeTool;
};

export function decisionSink(input: SinkInput): DecisionSink | null {
  let folder: string;
  let destination: ReturnType<typeof decisionDestination>;
  try {
    destination = decisionDestination(
      input.file,
      input.env ?? process.env,
      input.verified,
      250,
    );
    folder = decisionFolder(
      input.home ?? homedir(),
      input.file,
      destination.binding,
    );
  } catch (error) {
    input.warn(
      `Nodrail: decision reporting is off: can't use ${input.file}: ${(error as Error).message}\n`,
    );
    return null;
  }
  const policyDigest =
    input.policyDigest === undefined
      ? policyRevision(input.paths ?? [])
      : input.policyDigest;
  const queue = (entry: Queued) => {
    try {
      const queued = enqueue(folder, entry);
      wakeSender(folder, () =>
        startSender(input.self, folder, input.file, "decisions-send"),
      );
      return queued;
    } catch (error) {
      input.warn(
        `Nodrail: decision reporting failed: ${(error as Error).message}\n`,
      );
      return false;
    }
  };
  return {
    destination,
    observe: (observed) => {
      const item = decisionItem(observed, { ...input, policyDigest });
      if (item) queue({ type: "decision", item });
    },
    step: (run, event, details) => {
      const item = stepItem(run, event, details);
      if (item) queue({ type: "step", item });
    },
    outcome: (stdin) => queueOutcome(stdin, input, folder, queue),
    remember: (claims) => rememberClaims(folder, claims),
    cancel: (claims) => {
      queue({
        type: "outcome",
        key: claims[0]!.key,
        outcome: "failure",
        cancellation: true,
        settlements: settlementTargets(claims),
      });
    },
  };
}

function queueOutcome(
  stdin: string,
  input: SinkInput,
  folder: string,
  queue: (entry: QueuedOutcome) => boolean,
) {
  const event = parseEvent(stdin);
  if (!event) return;
  const outcome = outcomeFor(event, input.host, input.document, input.tool);
  if (!outcome) return;
  try {
    const claims = readClaims(folder, outcome.key);
    if (!claims.length) {
      queue(outcome);
      return;
    }
    if (
      queue({
        ...outcome,
        ...(outcome.outcome === "success"
          ? readOutcomeFields(event, {
              paths: [
                ...new Set(
                  claims.flatMap(({ readings }) => readings?.paths ?? []),
                ),
              ],
              tokens: claims.some(({ readings }) => readings?.tokens === true),
            })
          : {}),
        settlements: settlementTargets(claims),
        outcome: outcome.outcome === "failure" ? "unknown" : outcome.outcome,
      })
    )
      forgetClaims(folder, outcome.key);
  } catch (error) {
    input.warn(
      `Nodrail: shared budget outcome could not be queued: ${(error as Error).message}\n`,
    );
  }
}
