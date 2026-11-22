// The write a hook event asks for, as CAPABILITIES observed it: Claude Code
// Write (whole content) and Edit (old_string/new_string/replace_all);
// Copilot CLI apply_patch (the raw patch as the tool arguments). Other file
// tools are `unsupported`, never read as no write: MultiEdit and
// NotebookEdit have no reconstruction, and Codex's hooks don't show the
// patch (C9), so its writes can only be checked through a mediated writer.
import type { ClaudeEdit } from "./edit.ts";

export type WriteRequest =
  | { tool: "write"; path: string; content: string }
  | ({ tool: "edit"; path: string } & ClaudeEdit)
  | { tool: "patch"; patch: string };

export const WRITE_RUNTIMES = ["claude", "copilot", "codex"] as const;
export type WriteRuntime = (typeof WRITE_RUNTIMES)[number];

export type RequestReading =
  | { state: "write"; request: WriteRequest }
  /** Not a file write this module knows: other checks apply. */
  | { state: "none" }
  /** A file write whose result can't be known from the event. */
  | { state: "unsupported"; reason: string }
  /** A file write whose input doesn't have the observed form. */
  | { state: "invalid"; reason: string };

const CLAUDE_UNSUPPORTED = new Set(["MultiEdit", "NotebookEdit"]);
const COPILOT_UNSUPPORTED = new Set(["create", "edit", "str_replace", "write"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const invalid = (reason: string): RequestReading => ({
  state: "invalid",
  reason,
});

function claudeEdit(input: Record<string, unknown>): RequestReading {
  const { file_path, old_string, new_string, replace_all } = input;
  if (
    typeof file_path !== "string" ||
    typeof old_string !== "string" ||
    typeof new_string !== "string"
  )
    return invalid(
      "Edit needs file_path, old_string and new_string as strings",
    );
  if (replace_all !== undefined && typeof replace_all !== "boolean")
    return invalid("Edit replace_all must be a boolean");
  return {
    state: "write",
    request: {
      tool: "edit",
      path: file_path,
      oldString: old_string,
      newString: new_string,
      replaceAll: replace_all ?? false,
    },
  };
}

function claude(tool: string, input: unknown): RequestReading {
  if (CLAUDE_UNSUPPORTED.has(tool))
    return {
      state: "unsupported",
      reason: `${tool}'s result isn't reconstructed`,
    };
  if (tool !== "Write" && tool !== "Edit") return { state: "none" };
  if (!isRecord(input)) return invalid(`${tool} input isn't an object`);
  if (tool === "Edit") return claudeEdit(input);
  const { file_path, content } = input;
  if (typeof file_path !== "string" || typeof content !== "string")
    return invalid("Write needs file_path and content as strings");
  return {
    state: "write",
    request: { tool: "write", path: file_path, content },
  };
}

/** The write in one tool event, by runtime. */
export function readWriteRequest(
  runtime: WriteRuntime,
  tool: string,
  input: unknown,
): RequestReading {
  if (runtime === "claude") return claude(tool, input);
  if (tool !== "apply_patch")
    return runtime === "copilot" && COPILOT_UNSUPPORTED.has(tool)
      ? {
          state: "unsupported",
          reason: `Copilot ${tool} wasn't observed; its result isn't reconstructed`,
        }
      : { state: "none" };
  if (runtime === "codex")
    return {
      state: "unsupported",
      reason: "Codex hooks don't show the patch (C9); use a mediated writer",
    };
  if (typeof input !== "string")
    return invalid("apply_patch arguments aren't the raw patch text");
  return { state: "write", request: { tool: "patch", patch: input } };
}
