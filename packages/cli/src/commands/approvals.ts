import { isUuid, type Decision } from "../api.ts";
import type { Command } from "../context.ts";
import { approvalDetail, approvalsTable } from "../format.ts";
import { CliError, confirm, UsageError } from "../io.ts";
import { noArgs, requireArg } from "./auth.ts";

const WATCH_MS = 5_000;

export async function listApprovals(command: Command) {
  noArgs(command);
  const api = await command.api();
  const query = { agent: command.values.agent };
  for (;;) {
    const page = await api.approvals(query);
    if (command.values.watch && !command.values.json) command.io.clear();
    command.print(page, () => approvalsTable(page.items));
    if (!command.values.watch) return;
    if (!command.values.json)
      command.io.out(`\nRefreshing every 5 seconds. Ctrl-C to stop.`);
    if (!(await command.io.sleep(WATCH_MS))) return;
  }
}

const verbs: Record<Decision, { ask: string; done: string }> = {
  allow_once: { ask: "Approve this request once?", done: "Approved once" },
  deny: { ask: "Reject this request?", done: "Rejected" },
};

/** Shows exactly what is being decided, asks a person, then decides that. */
export async function decide(command: Command, decision: Decision) {
  const id = requireArg(command, "the request's ID");
  if (!isUuid(id))
    throw new UsageError(
      "Give the request's ID (a UUID, as `nodrail approvals` lists it), not its APR- reference.",
    );
  const { io, values } = command;
  if (!values.yes && !io.interactive)
    throw new UsageError(
      "Deciding needs a person to confirm. Run it at a terminal, or pass --yes.",
    );
  const api = await command.api();
  const approval = await api.approval(id);
  command.say(approvalDetail(approval));
  if (approval.state !== "pending")
    throw new CliError(`This request is ${approval.state}; nothing to decide.`);
  if (!values.yes && !(await confirm(io, verbs[decision].ask)))
    throw new CliError("Nothing was decided.");
  const decided = await api.decide(id, decision, approval.action_digest);
  command.print(
    decided,
    () => `${verbs[decision].done}: ${decided.reference}.`,
  );
}
