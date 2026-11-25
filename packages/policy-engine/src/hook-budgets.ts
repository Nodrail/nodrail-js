import { randomUUID } from "node:crypto";
import type { SharedBudgetClaim } from "./budget-claims.ts";
import { z } from "zod";
import {
  admissionAmount,
  type BudgetAuthority,
  type LimitState,
} from "./budget-ledger.ts";
import { callKey } from "./decision-report.ts";
import type { DecisionTarget } from "./decision-destination.ts";
import {
  judgeToolCall,
  parseEvent,
  type LocalHookOptions,
} from "./local-hook.ts";
import { readingFields } from "./outcome-readings.ts";
import { BUDGET_LABELS, limitsOf } from "./policies.ts";
import { runPlacement, stepOf } from "./run-hook.ts";
import type { Environment } from "./run-key.ts";

const response = z.object({
  expires_at: z.iso.datetime({ offset: true }).nullable(),
  reason: z.string().optional(),
  limits: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      label: z.enum(Object.keys(BUDGET_LABELS) as [keyof typeof BUDGET_LABELS]),
      unit: z.string(),
      limit: z.number(),
      used: z.number(),
      reserved: z.number(),
      unknown: z.number(),
      unread: z.number(),
      amount: z.number().nullable(),
      state: z.enum(["ok", "over", "unknown", "no_run"]),
      effect: z.literal("deny"),
      resets: z.string().nullable(),
    }),
  ),
});

const startReply = z.object({
  claim_id: z.uuid().nullable(),
  expires_at: response.shape.expires_at,
  started_at: response.shape.expires_at,
});

type RemoteOptions = {
  destination: DecisionTarget;
  env: Environment;
  policyDigest: string | null;
  onClaim?: (claim: SharedBudgetClaim) => void;
};

function unavailable(reason: string): BudgetAuthority {
  return {
    shared: (_budget, _call, state) => ({
      ...state,
      state: "unavailable",
      reason,
    }),
  };
}

function fromReply(
  reply: z.infer<typeof response>,
  ids: Set<string>,
): BudgetAuthority {
  if (reply.reason) return unavailable(reply.reason);
  const byId = new Map(reply.limits.map((limit) => [limit.id, limit]));
  if ([...ids].some((id) => !byId.has(id)))
    return unavailable(
      "The control plane did not confirm every shared budget.",
    );
  const blocking = reply.limits.find((limit) => limit.state !== "ok");
  if (!blocking && !reply.expires_at)
    return unavailable("The control plane did not grant a budget lease.");
  return {
    shared: (budget, _call, fallback): LimitState => {
      if (
        !blocking &&
        reply.expires_at &&
        Date.parse(reply.expires_at) > Date.now()
      )
        return byId.get(budget.id) ?? { ...fallback, state: "unavailable" };
      // When admission is atomic a refused budget also blocks other views of the call.
      return (
        blocking ?? {
          ...fallback,
          state: "unavailable",
          reason: "The shared budget lease expired.",
        }
      );
    },
  };
}

function requirements(
  stdin: string,
  options: LocalHookOptions,
  run: LocalHookOptions["run"],
) {
  const calls = new Map<string, { tool: string; operation: string }>();
  const ids = new Set<string>();
  const amounts: [string, number][] = [];
  judgeToolCall(stdin, {
    ...options,
    run,
    observe: null,
    budgets: {
      shared: (budget, call, fallback) => {
        const { tool, operation } = call;
        calls.set(`${tool}.${operation}`, { tool, operation });
        ids.add(budget.id);
        const amount = admissionAmount(budget, call);
        if (
          budget.measure.kind === "sum" &&
          budget.source === "admission" &&
          amount !== null
        )
          amounts.push([budget.id, amount]);
        return fallback;
      },
    },
  });
  return { calls, ids, amounts };
}

function budgetRequest(
  config: RemoteOptions,
  path: "reserve" | "start",
  body: object,
  send: typeof fetch,
) {
  const { url, credential } = config.destination;
  return send(`${url}/api/v1/runtime/budgets/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${credential}`,
    },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(500),
  });
}

async function authorityFor(
  {
    stdin,
    event,
    options,
  }: {
    stdin: string;
    event: Record<string, unknown>;
    options: LocalHookOptions;
  },
  config: RemoteOptions,
  send: typeof fetch,
): Promise<BudgetAuthority> {
  const { run } = runPlacement(event, config.env);
  const step = run ? stepOf(event) : null;
  const { calls, ids, amounts } = requirements(
    stdin,
    options,
    run ? { run, step, events: [] } : null,
  );
  if (!ids.size) return "local";
  const key = callKey(options.keyHost ?? options.host ?? "claude-code", event);
  if (!key || !config.policyDigest)
    return unavailable(
      "The host could not identify this call or its policy revision.",
    );

  const answer = await budgetRequest(
    config,
    "reserve",
    {
      call_fingerprint: key,
      policy_digest: config.policyDigest,
      calls: [...calls.values()],
      ...(amounts.length ? { amounts: Object.fromEntries(amounts) } : {}),
      ...(run ? { run: { key: run, step: step ?? undefined } } : {}),
    },
    send,
  );
  if (!answer.ok) throw new Error("Reservation failed");
  const reply = response.parse(await answer.json());
  if (!canStart(reply, ids)) return fromReply(reply, ids);
  const claim = await startLease(
    { ...config, policyDigest: config.policyDigest },
    key,
    reply.expires_at,
    send,
  );
  if (!claim)
    return unavailable("The shared budget execution claim was refused.");
  const readings = readingFields(
    limitsOf(options.document).filter(({ id }) => ids.has(id)),
  );
  config.onClaim?.({ ...claim, readings });
  return fromReply(reply, ids);
}

function canStart(
  reply: z.infer<typeof response>,
  ids: Set<string>,
): reply is z.infer<typeof response> & { expires_at: string } {
  return (
    !reply.reason &&
    !!reply.expires_at &&
    Date.parse(reply.expires_at) > Date.now() &&
    reply.limits.every(({ state }) => state === "ok") &&
    [...ids].every((id) => reply.limits.some((limit) => limit.id === id))
  );
}

async function startLease(
  config: RemoteOptions & { policyDigest: string },
  key: string,
  deadline: string,
  send: typeof fetch,
): Promise<SharedBudgetClaim | null> {
  const claimId = randomUUID();
  const sentAt = Date.now();
  const sentTick = performance.now();
  const start = await budgetRequest(
    config,
    "start",
    {
      call_fingerprint: key,
      policy_digest: config.policyDigest,
      claim_id: claimId,
    },
    send,
  );
  if (!start.ok) throw new Error("Start failed");
  const ack = startReply.parse(await start.json());
  if (ack.claim_id !== claimId || !ack.expires_at || !ack.started_at)
    return null;

  const expiresAt = Math.min(Date.parse(deadline), Date.parse(ack.expires_at));
  const remaining = expiresAt - Date.parse(ack.started_at);
  return {
    key,
    policyDigest: config.policyDigest,
    expiresAt: Math.min(expiresAt, sentAt + remaining),
    expiresTick: sentTick + remaining,
  };
}

/**
 * Find the call's shared limits using the same descriptions and contract
 * values as the evaluator, including a shell call's file-read views. Make
 * bounded reservation and start requests before the decision takes the run lock.
 */
export async function hookBudgetAuthority(
  stdin: string,
  options: LocalHookOptions,
  config: RemoteOptions,
  send: typeof fetch = fetch,
): Promise<BudgetAuthority> {
  if (
    !limitsOf(options.document).some(({ across }) => across === "environment")
  )
    return "local";
  const event = parseEvent(stdin) as Record<string, unknown> | null;
  if (event?.hook_event_name !== "PreToolUse") return "local";

  return authorityFor({ stdin, event, options }, config, send).catch(() =>
    unavailable("The control plane could not confirm the reservation."),
  );
}
