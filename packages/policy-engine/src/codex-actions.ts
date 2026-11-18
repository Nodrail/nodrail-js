// How Codex's own agent tools read as actions.
import { agentName } from "./names.ts";
import { fingerprint, type ActionDescriptor } from "./protocol.ts";
import { nonEmptyText } from "./text.ts";

type ToolInput = Record<string, unknown>;

/**
 * Codex starting a subagent: `agent_type` names its definition, and Codex
 * starts its default agent without one. The message it hands over arrives
 * encrypted, so only its fingerprint is kept.
 */
function codexSubagentCall(input: ToolInput): ActionDescriptor {
  const name = agentName(nonEmptyText(input.agent_type) ?? "default");
  return {
    tool: "codex",
    operation: "agent",
    resource: { kind: "agent", id: name },
    params: { agent_type: name, input_sha256: fingerprint(input) },
  };
}

/** Codex's other calls on agents it started: wait, send input, close… */
function codexCollaborationCall(
  name: string,
  input: ToolInput,
): ActionDescriptor {
  return {
    tool: "codex",
    operation: name.replace(/^collaboration/, ""),
    resource: { kind: "tool", id: name },
    params: { input_sha256: fingerprint(input) },
  };
}

/** Codex's names for working with subagents, without the spawn. */
export const CODEX_COLLABORATION = [
  "wait_agent",
  "send_input",
  "send_message",
  "followup_task",
  "resume_agent",
  "interrupt_agent",
  "close_agent",
  "list_agents",
] as const;

type CodexDescribe = (input: ToolInput) => ActionDescriptor;

/** Codex's tool names, with its namespace in front and without. */
export const codexDescribers: [string, CodexDescribe][] = [
  ["collaborationspawn_agent", codexSubagentCall],
  ["spawn_agent", codexSubagentCall],
  ...CODEX_COLLABORATION.flatMap((name): [string, CodexDescribe][] => [
    [`collaboration${name}`, (input) => codexCollaborationCall(name, input)],
    [name, (input) => codexCollaborationCall(name, input)],
  ]),
];
