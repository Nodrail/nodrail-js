import {
  allowQuietly,
  deny,
  describeToolCall,
  nonEmptyText,
  type HookResult,
  type ToolInput,
} from "./actions.ts";
import { connectionCall, type ConnectionCalls } from "./connections.ts";
import { checkContracts } from "./contract-calls.ts";
import type { Observed } from "./hook-telemetry.ts";
import type { BudgetAuthority } from "./budget-ledger.ts";
import type { Descriptor } from "./evaluator.ts";
import type { EvidenceReader } from "./run-evidence.ts";
import type { PolicyDocument } from "./policies.ts";
import type { ActionDescriptor } from "./protocol.ts";
import type { RunContext, RunEvent, Subject } from "./runs.ts";
import { HANDBACK_ACTION } from "./hook-runs.ts";
import { resolveHookCaller, type CallerEvent } from "./hook-caller.ts";
import {
  touchedData,
  touchedRules,
  touchedSetup,
  type DataGuard,
  type SetupGuard,
} from "./rules-guard.ts";
import { shellReadAction } from "./shell-reads.ts";
import { simulate, type SimulationResult } from "./simulator.ts";

export type Identity = { agent?: string; installation?: string };

export const toDescriptor = (
  action: ActionDescriptor,
  { agent, installation }: Identity = {},
): Descriptor => ({
  agentId: agent ?? "local-agent",
  installationId: installation ?? "local-install",
  toolKey: action.tool,
  operationKey: action.operation,
  resourceKind: action.resource.kind,
  resourceId: action.resource.id,
  params: action.params as Descriptor["params"],
});

export type StepReport = {
  message: string | null;
  via: "stop" | "handback";
};

export type LocalHookOptions = Identity & {
  document: PolicyDocument;
  /** The caller admitted by the control plane for a connected event. */
  caller?: string;
  accessRefusal?: string;
  pausedAgents?: string[];
  admission?: { id: string; call: string };
  pausedRun?: string | null;
  watch?: boolean;
  now: Date;
  /**
   * What to do when no rule covers a call: deny it, or allow it and leave it
   * to the host's own permissions. Denied unless set otherwise.
   */
  unmatched: "deny" | "allow";
  /** The run this call belongs to, when the rules have gates or budgets. */
  run?: RunContext | null;
  /** Reads the revision the work is at, for requirements with `subject: revision`. */
  subject?: Subject | null;
  /** Reads evidence for evidence requirements (version 4). */
  evidence?: EvidenceReader | null;
  /** Who counts numeric budgets (version 4): `local` is the run ledger. */
  budgets?: BudgetAuthority;
  /**
   * The host prefix of a call's key (`host:tool_use_id`): Copilot's calls
   * are judged as Claude Code's but keyed as Copilot's.
   */
  keyHost?: string;
  /** Rule files and folders no file tool may change, whatever the rules say. */
  protect?: readonly string[];
  /** A setup no shell command may name, whatever the rules say. */
  setup?: SetupGuard | null;
  /** The setup's tool connections: how to read a call to each. */
  connections?: ConnectionCalls | null;
  /** The data the connections keep, which agents reach only through them. */
  data?: DataGuard | null;
  /** The host whose hook this is: it decides how a plugin's tools are named. */
  host?: "claude-code" | "codex";
  /** Told of every judged call, as it was judged; can't change the result. */
  observe?: ((observed: Observed) => void) | null;
  /** Told of every run event recorded; can't change the result. */
  report?: ((run: string, event: RunEvent, step?: StepReport) => void) | null;
};

/** The same caller goes to policy evaluation, runs and observers. */
export function callerOf(event: CallerEvent, options: LocalHookOptions) {
  const { agent, installation } = options;
  const resolved = resolveHookCaller(event, agent ?? "main", options.caller);
  return { installation, agent: resolved.agent };
}

export const parseEvent = (stdin: string) => {
  try {
    return JSON.parse(stdin) as CallerEvent & {
      hook_event_name?: unknown;
      tool_name?: unknown;
      tool_input?: unknown;
      cwd?: unknown;
    };
  } catch {
    return null;
  }
};

export type Judged = {
  result: HookResult;
  /** What was decided, when the call could be described at all. */
  action: ActionDescriptor | null;
  decision: SimulationResult | null;
  refusal?: string;
};

const refused = (
  text: string,
  action: ActionDescriptor | null = null,
): Judged => ({
  result: deny(text),
  action,
  decision: null,
  refusal: text,
});

const heldByRun = (decision: SimulationResult) =>
  decision.reason === "gate" || decision.reason === "budget";

/**
 * A rule says what it does; a gate or budget says what is missing, so the
 * agent can fix it and retry. A gate is met by doing what it needs; a
 * used-up budget stays used up for the step or run. Nothing waits for a person.
 */
function denied(decision: SimulationResult, subject: string) {
  if (!heldByRun(decision))
    return `Nodrail: rule ${decision.matchedRuleId} denies ${subject}.`;
  return decision.reason === "budget"
    ? `Nodrail: ${decision.explanation} So ${subject} is denied.`
    : `Nodrail: ${decision.explanation} Until then, ${subject} is denied; meet the gate, then try again.`;
}

/**
 * What the hook refuses whatever the rules say: a file tool changing the
 * rules or the setup, and a shell command naming the setup or Nodrail.
 */
function guardRefusal(
  action: ActionDescriptor,
  input: ToolInput,
  event: { cwd?: unknown },
  options: LocalHookOptions,
) {
  const rules = touchedRules(action, options.protect ?? []);
  if (rules)
    return `Nodrail: ${rules} holds the rules this hook enforces, or the setup they come from, so changing it is denied. Change it yourself, outside the agent.`;
  const command = nonEmptyText(input.command);
  if (!options.setup || action.tool !== "shell" || !command) return null;
  // A read in a shape known exactly (`cat`, `sed -n`, `rg`…) changes
  // nothing: the file rules decide it, as they decide the Read tool. Codex
  // loads a skill this way.
  if (readView(action, input, event)) return null;
  const word = touchedSetup(
    command,
    nonEmptyText(event.cwd) ?? process.cwd(),
    options.setup,
  );
  return word
    ? `Nodrail: this command names ${word}, part of the setup this hook enforces or Nodrail itself, so it is denied. Change the setup yourself, outside the agent.`
    : null;
}

/**
 * A call reaching a connection's data by another way than the connection,
 * whatever the rules say: the connection's own rules decide who may read or
 * change what it keeps, and a file tool or the shell would go around them.
 */
function dataRefusal(
  action: ActionDescriptor,
  input: ToolInput,
  event: { cwd?: unknown },
  options: LocalHookOptions,
) {
  if (!options.data) return null;
  const place = touchedData(
    action,
    nonEmptyText(input.command),
    nonEmptyText(event.cwd) ?? process.cwd(),
    options.data,
  );
  return place
    ? `Nodrail: ${place.path} holds the data of connection ${place.connection}, so this call is denied. Agents reach it only through ${place.connection}, as its rules allow.`
    : null;
}

/** The file reads a shell call also is, or null. */
function readView(
  action: ActionDescriptor,
  input: ToolInput,
  event: { cwd?: unknown },
) {
  const command = nonEmptyText(input.command);
  return action.tool === "shell" && command
    ? shellReadAction(command, nonEmptyText(event.cwd))
    : null;
}

const STRICTNESS: Record<string, number> = { deny: 2, allow: 1 };

type View = { view: ActionDescriptor; decision: SimulationResult };

/**
 * Of a call and the read it also is, the decision that holds: a deny over an
 * allow over nothing. The call's own wins a tie, so its rules
 * keep the meaning they had.
 */
function stricter(call: View, read: View | null): View {
  if (!read) return call;
  const rank = (view: View) => STRICTNESS[view.decision.outcome] ?? 0;
  return rank(read) > rank(call) ? read : call;
}

/**
 * A hand-back no rule covers goes ahead (see HANDBACK_ACTION); a rule that
 * covers it, a gate or a budget decides it as written.
 */
function handbackDefault(
  view: ActionDescriptor,
  decision: SimulationResult,
): SimulationResult {
  const handback =
    view.tool === HANDBACK_ACTION.tool &&
    view.operation === HANDBACK_ACTION.operation;
  return handback && decision.outcome === "none"
    ? {
        ...decision,
        outcome: "allow",
        explanation:
          "No rule covers this hand-back, and a subagent may hand its report back to its caller unless a rule says otherwise.",
      }
    : decision;
}

/**
 * Decides a Claude Code PreToolUse event from local rules, with no server.
 * A call is allowed or denied with its reason; nothing ever waits for a person.
 */
export function judgeToolCall(
  stdin: string,
  options: LocalHookOptions,
): Judged {
  const judged = judgeCall(stdin, options);
  if (options.observe) {
    const event = parseEvent(stdin);
    options.observe({
      judged,
      event: event as Record<string, unknown> | null,
      agent: callerOf(event ?? {}, options).agent ?? null,
      run: options.pausedRun ?? options.run?.run ?? null,
      ...(options.admission ? { admission: options.admission } : {}),
      ...(options.pausedAgents ? { pausedAgents: options.pausedAgents } : {}),
      step: options.run?.step?.id ?? null,
      ...(options.watch ? { watch: true } : {}),
    });
  }
  return judged;
}

function describeEvent(stdin: string, options: LocalHookOptions) {
  const event = parseEvent(stdin);
  if (event?.hook_event_name !== "PreToolUse")
    return "Nodrail: unsupported hook event, so this action is blocked.";
  const name = nonEmptyText(event.tool_name);
  const input = event.tool_input;
  if (!name || typeof input !== "object" || input === null)
    return "Nodrail: this call could not be identified, so it is blocked.";
  const action = describedCall(name, input as ToolInput, event, options);
  return typeof action === "string"
    ? action
    : { action, event, input: input as ToolInput };
}

function integrityOf(
  call: Exclude<ReturnType<typeof describeEvent>, string>,
  options: LocalHookOptions,
) {
  const { action, input, event } = call;
  return (
    guardRefusal(action, input, event, options) ??
    dataRefusal(action, input, event, options)
  );
}

/**
 * Enforce the same protected paths, setup files and connection data in watch
 * mode as in the policy evaluator, even if policy or ledger reads fail.
 */
export function toolIntegrity(stdin: string, options: LocalHookOptions) {
  const call = describeEvent(stdin, options);
  if (typeof call === "string") return null;
  const reason = integrityOf(call, options);
  return reason ? deny(reason) : null;
}

function judgeCall(stdin: string, options: LocalHookOptions): Judged {
  const call = describeEvent(stdin, options);
  if (typeof call === "string") return refused(call);
  const { action, event, input } = call;
  if (options.accessRefusal) return refused(options.accessRefusal, action);
  const guarded = integrityOf(call, options);
  if (guarded) return refused(guarded, action);
  const contracted = checkContracts(
    options.document,
    action,
    input as ToolInput,
  );
  if ("refusal" in contracted) return refused(contracted.refusal);
  const { values } = contracted;

  const { document, now, unmatched, run } = options;
  const caller = callerOf(event, options);
  const judge = (view: ActionDescriptor) =>
    handbackDefault(
      view,
      simulate({
        document,
        descriptor: toDescriptor(view, caller),
        caller: options.caller,
        now,
        run,
        subject: options.subject,
        evidence: options.evidence,
        budgets: options.budgets,
        // A read a shell call also is has no declared input.
        values: view === action ? values : null,
      }),
    );
  // A shell command that only reads a file is also judged as that read, so
  // the file rules apply to it, secrets included. The stricter decision wins.
  const reads = readView(action, input, event) ?? [];
  const { view, decision } = reads.reduce(
    (strictest, read) =>
      stricter(strictest, { view: read, decision: judge(read) }),
    { view: action, decision: judge(action) },
  );
  const subject = `${view.tool} ${view.operation} on ${view.resource.id}`;
  const judged = (result: HookResult) => ({ result, action, decision });
  switch (decision.outcome) {
    case "allow":
      // Silence defers to Claude Code's permissions: a rule can only narrow them.
      return judged(allowQuietly);
    case "deny":
      return judged(deny(denied(decision, subject)));
    default:
      // Allowed when set so, like an allow: the host's permissions decide.
      return judged(
        unmatched === "allow"
          ? allowQuietly
          : deny(
              `Nodrail: no rule covers ${subject}, so it is denied. Add a rule that allows it if it should run.`,
            ),
      );
  }
}

/**
 * The call as an action: a call to one of the setup's connections as its
 * declaration says, any other as the host's tool it is. Why not, if it
 * can't be read.
 */
export function describedCall(
  name: string,
  input: ToolInput,
  event: { cwd?: unknown },
  options: Pick<LocalHookOptions, "connections" | "host">,
): ActionDescriptor | string {
  const declared = options.connections
    ? connectionCall(name, input, options.connections, options.host)
    : null;
  if (typeof declared === "string")
    return `Nodrail: ${declared}, so this call is blocked.`;
  return (
    declared ??
    describeToolCall(name, input, nonEmptyText(event.cwd)) ??
    "Nodrail: this call could not be described, so it is blocked."
  );
}

export function decideToolCall(
  stdin: string,
  options: LocalHookOptions,
): HookResult {
  return judgeToolCall(stdin, options).result;
}
