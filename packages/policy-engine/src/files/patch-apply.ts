// An `*** Update File` applied to the current text as Codex's apply_patch
// does, with exact line matching only. The host may also try whitespace-
// trimmed and punctuation-normalized matches when the exact one fails; a
// result found that way isn't reconstructed, so a check refuses it instead
// of guessing what the host would write. Hunks apply in order, each after
// the last; the result always ends with a newline, as the host writes it.
import type { Reconstruction } from "./edit.ts";
import type { PatchChunk } from "./patch.ts";

type Replacement = { start: number; remove: number; insert: string[] };

/** First exact run of `pattern` at or after `from`; at the very end for an end-of-file hunk. */
function seek(
  lines: string[],
  pattern: string[],
  from: number,
  endOfFile: boolean,
) {
  if (!pattern.length) return from;
  if (pattern.length > lines.length) return -1;
  const start = endOfFile ? lines.length - pattern.length : from;
  for (
    let at = Math.max(start, 0);
    at + pattern.length <= lines.length;
    at += 1
  )
    if (pattern.every((line, index) => lines[at + index] === line)) return at;
  return -1;
}

const refuse = (message: string): Reconstruction => ({
  ok: false,
  code: "not-found",
  message,
});

/** Where one hunk applies, or null; a trailing empty line may be dropped, as the host does. */
function place(
  lines: string[],
  chunk: PatchChunk,
  from: number,
): Replacement | null {
  let pattern = chunk.oldLines;
  let insert = chunk.newLines;
  let at = seek(lines, pattern, from, chunk.endOfFile);
  if (at < 0 && pattern.at(-1) === "") {
    pattern = pattern.slice(0, -1);
    if (insert.at(-1) === "") insert = insert.slice(0, -1);
    at = seek(lines, pattern, from, chunk.endOfFile);
  }
  return at < 0 ? null : { start: at, remove: pattern.length, insert };
}

function replacements(lines: string[], chunks: PatchChunk[]) {
  const found: Replacement[] = [];
  let from = 0;
  for (const [index, chunk] of chunks.entries()) {
    if (chunk.context !== null) {
      const at = seek(lines, [chunk.context], from, false);
      if (at < 0)
        return refuse(
          `hunk ${index + 1}: its @@ line isn't in the file exactly`,
        );
      from = at + 1;
    }
    if (!chunk.oldLines.length) {
      // Pure additions go at the end of the file.
      const end = lines.at(-1) === "" ? lines.length - 1 : lines.length;
      found.push({ start: end, remove: 0, insert: chunk.newLines });
      continue;
    }
    const replacement = place(lines, chunk, from);
    if (!replacement)
      return refuse(`hunk ${index + 1}: its lines aren't in the file exactly`);
    found.push(replacement);
    from = replacement.start + replacement.remove;
  }
  return found;
}

/** The text an update leaves, or why it can't be known exactly. */
export function applyUpdate(
  current: string,
  chunks: PatchChunk[],
): Reconstruction {
  const lines = current.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const found = replacements(lines, chunks);
  if (!Array.isArray(found)) return found;
  const result = [...lines];
  // Back to front, so earlier positions still hold.
  for (const { start, remove, insert } of [...found].sort(
    (a, b) => b.start - a.start,
  ))
    result.splice(start, remove, ...insert);
  if (result.at(-1) !== "") result.push("");
  return { ok: true, content: result.join("\n") };
}
