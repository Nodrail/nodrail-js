import {
  allowQuietly,
  askPerson,
  deny,
  describeToolCall,
  nonEmptyText,
  type HookResult,
  type ToolInput,
} from "./actions.ts";
import { connectionCall, type ConnectionCalls } from "./connections.ts";
import { checkContracts, type ContractCall } from "./contract-calls.ts";
import type { Observed } from "./hook-telemetry.ts";
import type { BudgetAuthority } from "./budget-ledger.ts";
import type { Descriptor } from "./evaluator.ts";
import type { EvidenceReader } from "./run-evidence.ts";
import type { PolicyDocument } from "./policies.ts";
import type { ActionDescriptor } from "./protocol.ts";
import type { RunContext, RunEvent, Subject } from "./runs.ts";
import { HANDBACK_ACTION } from "./hook-runs.ts";
import { agentName } from "./names.ts";
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

export type LocalHookOptions = Identity & {
  document: PolicyDocument;
  now: Date;
  /** What to do when no rule covers a call. Blocked unless asked otherwise. */
  unmatched: "deny" | "ask";
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
  /**
   * Whether the host can ask the person. Codex can't: it treats an "ask"
   * answer as a failed hook and runs the call, so a review is a deny there.
   */
  canAsk?: boolean;
  /** The setup's tool connections: how to read a call to each. */
  connections?: ConnectionCalls | null;
  /** The data the connections keep, which agents reach only through them. */
  data?: DataGuard | null;
  /** The host whose hook this is: it decides how a plugin's tools are named. */
  host?: "claude-code" | "codex";
  /** Told of every judged call, as it was judged; can't change the result. */
  observe?: ((observed: Observed) => void) | null;
  /** Told of every run event recorded; can't change the result. */
  report?: ((run: string, event: RunEvent) => void) | null;
};

/**
 * Who is calling. Claude Code and Codex name the agent a call comes from:
 * a subagent's own type, or the session's `--agent`. The host sets it from
 * the agent definition it started, not from anything the model writes, so it
 * wins over this hook's `--agent`, which names the entry agent for calls the
 * host doesn't label.
 */
function callerOf(
  event: { agent_type?: unknown },
  identity: Identity,
): Identity {
  const named = nonEmptyText(event.agent_type);
  return named ? { ...identity, agent: agentName(named) } : identity;
}

export const parseEvent = (stdin: string) => {
  try {
    return JSON.parse(stdin) as {
      hook_event_name?: unknown;
      tool_name?: unknown;
      tool_input?: unknown;
      cwd?: unknown;
      agent_type?: unknown;
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
};

const refused = (text: string): Judged => ({
  result: deny(text),
  action: null,
  decision: null,
});

const heldByRun = (decision: SimulationResult) =>
  decision.reason === "gate" || decision.reason === "budget";

/** A gate waits for something; a used-up budget stays used up for the step or run. */
const holdLead = (decision: SimulationResult) =>
  decision.reason === "budget" ? "Over the limit," : "Until then,";

/** A rule says what it does; a gate or budget says what it is waiting for. */
function denied(decision: SimulationResult, subject: string) {
  return heldByRun(decision)
    ? `Nodrail: ${decision.explanation} ${holdLead(decision)} ${subject} is denied.`
    : `Nodrail: rule ${decision.matchedRuleId} denies ${subject}.`;
}

function toReview(decision: SimulationResult, subject: string) {
  return heldByRun(decision)
    ? `Nodrail: ${decision.explanation} ${holdLead(decision)} a person must review ${subject}.`
    : `Nodrail: rule ${decision.matchedRuleId} needs a person to review ${subject}.`;
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

const STRICTNESS: Record<string, number> = {
  deny: 3,
  require_approval: 2,
  allow: 1,
};

type View = { view: ActionDescriptor; decision: SimulationResult };

/**
 * Of a call and the read it also is, the decision that holds: a deny over a
 * review over an allow over nothing. The call's own wins a tie, so its rules
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

/** On a host that can't ask, a review is refused and says why. */
const cannotAsk = (reason: string) =>
  deny(`${reason} This host can't ask a person, so it is denied.`);

/**
 * Decides a Claude Code PreToolUse event from local rules, with no server.
 * Nobody is waiting to review here, so a review goes to the person at the keyboard.
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
      run: options.run?.run ?? null,
      step: options.run?.step?.id ?? null,
    });
  }
  return judged;
}

function judgeCall(stdin: string, options: LocalHookOptions): Judged {
  const event = parseEvent(stdin);
  if (event?.hook_event_name !== "PreToolUse")
    return refused(
      "Nodrail: unsupported hook event, so this action is blocked.",
    );
  const name = nonEmptyText(event.tool_name);
  const input = event.tool_input;
  if (!name || typeof input !== "object" || input === null)
    return refused(
      "Nodrail: this call could not be identified, so it is blocked.",
    );
  const contracted = contractedCall(name, input as ToolInput, event, options);
  if ("refusal" in contracted) return refused(contracted.refusal);
  const { action, values } = contracted;
  const guarded =
    guardRefusal(action, input as ToolInput, event, options) ??
    dataRefusal(action, input as ToolInput, event, options);
  if (guarded) return refused(guarded);

  const { document, now, unmatched, run } = options;
  const ask = options.canAsk === false ? cannotAsk : askPerson;
  const caller = callerOf(event, options);
  const judge = (view: ActionDescriptor) =>
    handbackDefault(
      view,
      simulate({
        document,
        descriptor: toDescriptor(view, caller),
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
  const reads = readView(action, input as ToolInput, event) ?? [];
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
    case "require_approval":
      return judged(ask(toReview(decision, subject)));
    default:
      return judged(
        (unmatched === "ask" ? ask : deny)(
          `Nodrail: no rule covers ${subject}.`,
        ),
      );
  }
}

/**
 * The call as an action: a call to one of the setup's connections as its
 * declaration says, any other as the host's tool it is. Why not, if it
 * can't be read.
 */
function describedCall(
  name: string,
  input: ToolInput,
  event: { cwd?: unknown },
  options: LocalHookOptions,
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

/**
 * The call as an action, with its declared brief or input checked on the
 * exact call before any rule; or why it is refused.
 */
function contractedCall(
  name: string,
  input: ToolInput,
  event: { cwd?: unknown },
  options: LocalHookOptions,
): ContractCall {
  const described = describedCall(name, input, event, options);
  if (typeof described === "string") return { refusal: described };
  return checkContracts(options.document, described, input);
}

export function decideToolCall(
  stdin: string,
  options: LocalHookOptions,
): HookResult {
  return judgeToolCall(stdin, options).result;
}
