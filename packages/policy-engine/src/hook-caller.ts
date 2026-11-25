import { agentName } from "./names.ts";

export type CallerEvent = {
  agent_type?: unknown;
  agent_name?: unknown;
  session_agent?: unknown;
  agent_id?: unknown;
  session_id?: unknown;
};

/** Only host metadata can name a caller. Connection owners admit the candidate. */
export function callerCandidate(event: CallerEvent) {
  const name = [event.agent_type, event.agent_name, event.session_agent].find(
    (value): value is string =>
      typeof value === "string" && value.trim().length > 0,
  );
  return name === undefined ? undefined : agentName(name);
}

export function resolveHookCaller(
  event: CallerEvent,
  host: string,
  resolved?: string,
) {
  const agent = resolved ?? callerCandidate(event) ?? host;
  const id =
    typeof event.agent_id === "string" ? event.agent_id.slice(0, 200) : "";
  return { agent, step: id ? { id, agent } : undefined };
}
