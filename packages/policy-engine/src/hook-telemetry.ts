import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import type { Judged } from "./local-hook.ts";
import type { PolicyDocument } from "./policies.ts";
import {
  decisionSpan,
  enqueue,
  spoolFolder,
  startSender,
  wakeSender,
} from "./telemetry.ts";
import { telemetryFile } from "./telemetry-schema.ts";
import type { SpanRecord } from "./otlp.ts";
import { telemetryId } from "./machine-id.ts";
import { policyRevision, runEventSpan, runRef } from "./reporting-spans.ts";
import type { RunEvent } from "./runs.ts";

/** What the hook hands its observer once a call is judged. */
export type Observed = {
  judged: Judged;
  event: Record<string, unknown> | null;
  agent: string | null;
  watch?: boolean;
  pausedAgents?: string[];
  admission?: { id: string; call: string };
  /** The run's ledger key and the step, when the rules keep a ledger. */
  run?: string | null;
  step?: string | null;
};

/** What the hook tells telemetry: each decision, and each run event. */
export type Reporter = {
  observe: (observed: Observed) => void;
  report: (run: string, event: RunEvent) => void;
};

const now = () => BigInt(Date.now()) * 1_000_000n;

/**
 * What the host was told: a deny, or nothing, which lets the call through.
 * That is the decision, whatever matched: no rule is a deny unless the hook
 * allows unmatched calls.
 */
export function told(judged: Judged) {
  if (!judged.result.stdout) return "allow";
  try {
    const answer = JSON.parse(judged.result.stdout) as {
      hookSpecificOutput?: { permissionDecision?: string };
    };
    const decision = answer.hookSpecificOutput?.permissionDecision;
    return decision ?? "deny";
  } catch {
    return "deny";
  }
}

export function reportedVerdict({ judged, watch }: Observed) {
  const verdict = told(judged);
  return watch && verdict === "deny" ? "would_deny" : verdict;
}

export type HookReporting = {
  file: string;
  host: string;
  document: PolicyDocument;
  /** The rules the hook was given, for the policy's full revision. */
  paths?: readonly string[];
  policyDigest?: string | null;
  /** How to run this command line again, for the sender. */
  self: readonly string[];
  warn: (text: string) => void;
  home?: string;
};

/**
 * The hook's observer for `--telemetry <file>`: each decision becomes a span
 * in the queue, and a sender is woken. Telemetry never changes or delays a
 * decision: a file that can't be read only turns it off, with a warning.
 */
export function telemetryObserver(input: HookReporting): Reporter | null {
  let folder: string;
  let machine: string;
  // Reporting never decides: anything that keeps it from starting, the
  // machine id's folder included, turns it off with a warning, and the
  // policy's answer stands.
  try {
    telemetryFile.parse(JSON.parse(readFileSync(input.file, "utf8")));
    folder = spoolFolder(input.home ?? homedir(), input.file);
  } catch (error) {
    input.warn(
      `Nodrail: telemetry is off: can't read ${input.file}: ${(error as Error).message}\n`,
    );
    return null;
  }
  try {
    machine = telemetryId(input.home ?? homedir());
  } catch (error) {
    input.warn(
      `Nodrail: telemetry is off: can't keep this machine's id in ~/.nodrail: ${(error as Error).message}\n`,
    );
    return null;
  }
  const revision = createHash("sha256")
    .update(JSON.stringify(input.document))
    .digest("hex")
    .slice(0, 16);
  const policy = input.policyDigest ?? policyRevision(input.paths ?? []);
  const started = now();
  const queue = (span: SpanRecord) => {
    try {
      enqueue(folder, span);
      wakeSender(folder, () => startSender(input.self, folder, input.file));
    } catch (error) {
      input.warn(`Nodrail: telemetry failed: ${(error as Error).message}\n`);
    }
  };
  return {
    observe: (observed) => {
      const { judged, event, agent, run, step } = observed;
      queue(
        decisionSpan({
          event,
          host: input.host,
          agent,
          action: judged.action,
          decision: reportedVerdict(observed),
          matched: judged.decision?.outcome ?? null,
          rule: judged.decision?.matchedRuleId ?? null,
          revision,
          policyRevision: policy,
          machine,
          run: run ? runRef(run) : null,
          step: step ?? null,
          started,
          ended: now(),
        }),
      );
    },
    report: (run, event) =>
      queue(runEventSpan({ run, event, host: input.host, machine })),
  };
}
