// The file Claude Code's Write and Edit tools would leave, from the current
// text and the tool input alone (CAPABILITIES C6, C7). Write gives the whole
// file. Edit is replayed as Claude Code applies it: the file is read with
// CRLF folded to LF and written back with CRLF; old_string must occur, and
// exactly once unless replace_all; an empty old_string creates a file that
// is missing or empty; and deleting a fragment that a newline follows also
// deletes that newline. When the exact text isn't found, Claude Code may
// retry with curly quotes straightened: that result is not reconstructed,
// so a check refuses it rather than guess.

export type Reconstruction =
  { ok: true; content: string } | { ok: false; code: string; message: string };

export type ClaudeEdit = {
  oldString: string;
  newString: string;
  replaceAll: boolean;
};

const refuse = (code: string, message: string): Reconstruction => ({
  ok: false,
  code,
  message,
});

/** Non-overlapping occurrences, as a split counts them. */
function occurrences(text: string, part: string) {
  let count = 0;
  for (
    let at = text.indexOf(part);
    at >= 0;
    at = text.indexOf(part, at + part.length)
  )
    count += 1;
  return count;
}

const replaceFirst = (text: string, part: string, by: string) => {
  const at = text.indexOf(part);
  return text.slice(0, at) + by + text.slice(at + part.length);
};

/** Claude Code's replacement: a deleted fragment takes its newline with it. */
function replaced(text: string, edit: ClaudeEdit) {
  const part =
    edit.newString === "" &&
    !edit.oldString.endsWith("\n") &&
    text.includes(`${edit.oldString}\n`)
      ? `${edit.oldString}\n`
      : edit.oldString;
  return edit.replaceAll
    ? text.split(part).join(edit.newString)
    : replaceFirst(text, part, edit.newString);
}

function created(current: string | null, edit: ClaudeEdit): Reconstruction {
  if (current !== null && current.trim() !== "")
    return refuse(
      "exists",
      "an empty old_string only creates a file; this one has content",
    );
  return { ok: true, content: edit.newString };
}

/** The file an Edit would leave; `current` is null when there is no file. */
export function applyClaudeEdit(
  current: string | null,
  edit: ClaudeEdit,
): Reconstruction {
  if (edit.oldString === "") return created(current, edit);
  if (current === null) return refuse("missing", "the file doesn't exist");
  if (edit.oldString === edit.newString)
    return refuse("no-change", "old_string and new_string are the same");
  const crlf = current.includes("\r\n");
  const text = crlf ? current.replace(/\r\n/g, "\n") : current;
  const count = occurrences(text, edit.oldString);
  if (count === 0)
    return refuse("not-found", "old_string isn't in the file exactly");
  if (count > 1 && !edit.replaceAll)
    return refuse(
      "ambiguous",
      `old_string occurs ${count} times; give more context or replace_all`,
    );
  const result = replaced(text, edit);
  return { ok: true, content: crlf ? result.replace(/\n/g, "\r\n") : result };
}

/** The file a Write would leave: exactly its content. */
export const applyClaudeWrite = (content: string): Reconstruction => ({
  ok: true,
  content,
});
