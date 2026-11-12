// What counts as a change in a run: an action after which a review no longer
// describes the work. Pure: Cloud calls this for actions it records.
import { EXACT_LOOKING_COMMANDS, LOOKING_COMMANDS } from "./packs.ts";

/** What the file tools write, edit, delete or patch, notebooks included. */
export const CHANGING_FILE_OPERATIONS = new Set([
  "file.write",
  "file.edit",
  "file.delete",
  "file.patch",
  "notebook.edit",
]);

/** The parts of an action descriptor a change is judged by. */
export type ChangeSubject = {
  tool: string;
  operation: string;
  resource: { kind: string; id: string };
};

/** A command the read-only starter pack allows as only looking around. */
function onlyLooks(command: string) {
  return (
    LOOKING_COMMANDS.some(
      (prefix) => command === prefix || command.startsWith(`${prefix} `),
    ) || (EXACT_LOOKING_COMMANDS as readonly string[]).includes(command)
  );
}

/**
 * Whether an action changes things: a file written, edited, deleted or
 * patched, a notebook edited, or a shell command other than the read-only
 * pack's look-around commands. Starting a subagent, reads, searches, web and
 * MCP tools are not changes. Record it only for actions that went ahead: a
 * denied action changed nothing.
 */
export function isChange({ tool, operation, resource }: ChangeSubject) {
  if (tool === "files") return CHANGING_FILE_OPERATIONS.has(operation);
  if (tool !== "shell") return false;
  return !(
    operation === "command.run" &&
    resource.kind === "command" &&
    onlyLooks(resource.id)
  );
}
