// The apply_patch format Copilot CLI sends (CAPABILITIES C6, C7) and Codex
// defines: `*** Begin Patch`, then per file `*** Add File:` with `+` lines,
// `*** Delete File:`, or `*** Update File:` with an optional `*** Move to:`
// and `@@` hunks of ` `, `-` and `+` lines, then `*** End Patch`. Parsed
// strictly: anything the format doesn't define is refused, so a patch read
// here is never read differently by the host in a way that passes a check.
import { FILE_LIMITS } from "./limits.ts";

export type PatchChunk = {
  /** The `@@ <line>` anchor: the hunk applies after the first line equal to it. */
  context: string | null;
  oldLines: string[];
  newLines: string[];
  /** `*** End of File`: the hunk must match the end of the file. */
  endOfFile: boolean;
};

export type PatchOperation =
  | { kind: "add"; path: string; content: string }
  | { kind: "delete"; path: string }
  | {
      kind: "update";
      path: string;
      moveTo: string | null;
      chunks: PatchChunk[];
    };

export type PatchParse =
  | { ok: true; operations: PatchOperation[] }
  | { ok: false; code: string; message: string; line: number | null };

const BEGIN = "*** Begin Patch";
const END = "*** End Patch";
const ADD = "*** Add File: ";
const DELETE = "*** Delete File: ";
const UPDATE = "*** Update File: ";
const MOVE = "*** Move to: ";
const END_OF_FILE = "*** End of File";

class PatchError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly line: number | null,
  ) {
    super(message);
  }
}

type Cursor = { lines: string[]; at: number; hunks: number };

const peek = (cursor: Cursor) => cursor.lines[cursor.at];
const marker = (line: string | undefined) => line?.startsWith("*** ") ?? false;

function pathAfter(line: string, prefix: string, cursor: Cursor) {
  const path = line.slice(prefix.length).trim();
  if (!path) throw new PatchError("grammar", "names no file", cursor.at + 1);
  return path;
}

function addFile(cursor: Cursor, path: string): PatchOperation {
  let content = "";
  for (let line = peek(cursor); line?.startsWith("+"); line = peek(cursor)) {
    content += `${line.slice(1)}\n`;
    cursor.at += 1;
  }
  return { kind: "add", path, content };
}

/** One changed line of a hunk; false when the hunk has ended. */
function hunkLine(line: string | undefined, chunk: PatchChunk) {
  if (line === undefined || marker(line) || line.startsWith("@@")) return false;
  const body = line.slice(1);
  if (line === "" || line[0] === " ") {
    chunk.oldLines.push(body);
    chunk.newLines.push(body);
  } else if (line[0] === "-") chunk.oldLines.push(body);
  else if (line[0] === "+") chunk.newLines.push(body);
  else return false;
  return true;
}

function chunk(cursor: Cursor, first: boolean): PatchChunk {
  const head = peek(cursor)!;
  const found: PatchChunk = {
    context: null,
    oldLines: [],
    newLines: [],
    endOfFile: false,
  };
  if (head === "@@" || head.startsWith("@@ ")) {
    found.context = head === "@@" ? null : head.slice(3);
    cursor.at += 1;
  } else if (!first)
    throw new PatchError("grammar", "expected an @@ hunk", cursor.at + 1);
  const start = cursor.at;
  while (hunkLine(peek(cursor), found)) cursor.at += 1;
  if (cursor.at === start)
    throw new PatchError("grammar", "a hunk has no lines", cursor.at + 1);
  if (peek(cursor) === END_OF_FILE) {
    found.endOfFile = true;
    cursor.at += 1;
  }
  cursor.hunks += 1;
  if (cursor.hunks > FILE_LIMITS.patchHunks)
    throw new PatchError(
      "size",
      `expected at most ${FILE_LIMITS.patchHunks} hunks`,
      null,
    );
  return found;
}

function updateFile(cursor: Cursor, path: string): PatchOperation {
  let moveTo: string | null = null;
  const next = peek(cursor);
  if (next?.startsWith(MOVE)) {
    moveTo = pathAfter(next, MOVE, cursor);
    cursor.at += 1;
  }
  const chunks: PatchChunk[] = [];
  while (peek(cursor) !== undefined && !marker(peek(cursor)))
    chunks.push(chunk(cursor, chunks.length === 0));
  if (!chunks.length)
    throw new PatchError("grammar", "an update has no hunks", cursor.at + 1);
  return { kind: "update", path, moveTo, chunks };
}

function operation(cursor: Cursor): PatchOperation {
  const line = peek(cursor)!;
  cursor.at += 1;
  if (line.startsWith(ADD))
    return addFile(cursor, pathAfter(line, ADD, cursor));
  if (line.startsWith(DELETE))
    return { kind: "delete", path: pathAfter(line, DELETE, cursor) };
  if (line.startsWith(UPDATE))
    return updateFile(cursor, pathAfter(line, UPDATE, cursor));
  throw new PatchError("grammar", "expected a file operation", cursor.at);
}

/** A whole patch, or why it can't be read. */
export function parsePatch(patch: string): PatchParse {
  if (patch.length > FILE_LIMITS.patchBytes)
    return {
      ok: false,
      code: "size",
      message: `expected at most ${FILE_LIMITS.patchBytes} characters`,
      line: null,
    };
  const lines = patch.trim().split("\n");
  if (lines.some((line) => line.endsWith("\r")))
    return {
      ok: false,
      code: "line-ending",
      message: "has CRLF line ends",
      line: null,
    };
  if (lines[0]?.trim() !== BEGIN || lines.at(-1)?.trim() !== END)
    return {
      ok: false,
      code: "grammar",
      message: `expected ${BEGIN} … ${END}`,
      line: null,
    };
  const cursor: Cursor = { lines: lines.slice(0, -1), at: 1, hunks: 0 };
  const operations: PatchOperation[] = [];
  try {
    while (cursor.at < cursor.lines.length) {
      operations.push(operation(cursor));
      if (operations.length > FILE_LIMITS.patchFiles)
        throw new PatchError(
          "size",
          `expected at most ${FILE_LIMITS.patchFiles} files`,
          null,
        );
    }
  } catch (error) {
    if (!(error instanceof PatchError)) throw error;
    return {
      ok: false,
      code: error.code,
      message: error.message,
      line: error.line,
    };
  }
  if (!operations.length)
    return {
      ok: false,
      code: "grammar",
      message: "changes no file",
      line: null,
    };
  return { ok: true, operations };
}
