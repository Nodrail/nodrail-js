// What a write request would do to each file it touches: the operation and
// the complete proposed content, reconstructed from the current contents a
// caller supplies (no file system here). A path that is unsafe, or named
// twice in one request, refuses the whole request: its outcome would depend
// on an order or a resolution this check can't see.
import type { posix } from "node:path";
import { pathKey, projectPath, type PathResult } from "./contracts.ts";
import { applyClaudeEdit, type Reconstruction } from "./edit.ts";
import { FILE_LIMITS } from "./limits.ts";
import { applyUpdate } from "./patch-apply.ts";
import { parsePatch, type PatchOperation } from "./patch.ts";
import type { WriteRequest } from "./requests.ts";
import { readText } from "./text.ts";

export type CurrentFile =
  | { state: "absent" }
  | {
      state: "present";
      content: string | Uint8Array;
      /** What a mediated writer compares before writing; the fs adapter sets it. */
      revision?: string | null;
    }
  /** The adapter refused to read it: a symlink, a hard link, not a regular file. */
  | { state: "unsafe"; reason: string };

export type ChangeOperation = "create" | "update" | "delete" | "move";

export type FileChange = {
  /** Project-relative; for a move, the destination. Null outside the project. */
  path: string | null;
  operation: ChangeOperation;
  /** A move's project-relative source. */
  from: string | null;
  /** The complete proposed content; null for a delete or when it can't be known. */
  content: string | null;
  /** Why the content can't be known. */
  problem: { code: string; message: string } | null;
};

export type PlanContext = {
  /** Absolute project folder, or several spellings of that one folder. */
  projectRoot: string | string[];
  /** Absolute folder relative tool paths resolve against. */
  cwd: string;
  /** Explicit syntax for off-host paths whose project root is ambiguous. */
  pathFlavor?: typeof posix;
  current: (path: string) => CurrentFile;
  /** A disk adapter can resolve aliases before matching contracts or duplicates. */
  locate?: (name: string) => PathResult;
};

export type Plan =
  | { ok: true; changes: FileChange[] }
  | { ok: false; code: string; message: string };

class Refusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Project path of a tool path; null when outside the project. */
function located(name: string, context: PlanContext) {
  const found =
    context.locate?.(name) ??
    projectPath(context.projectRoot, context.cwd, name, context.pathFlavor);
  if (found.ok) return found.path;
  if (found.code === "outside") return null;
  throw new Refusal(found.code, `a path ${found.message}`);
}

/** The current text, or why it can't be read as text. */
function currentText(file: CurrentFile): {
  text: string | null;
  problem: FileChange["problem"];
} {
  if (file.state === "absent") return { text: null, problem: null };
  if (file.state === "unsafe")
    return {
      text: null,
      problem: { code: "unsafe-path", message: file.reason },
    };
  const read = readText(file.content, FILE_LIMITS.maxBytes);
  return read.ok
    ? { text: read.text, problem: null }
    : {
        text: null,
        problem: {
          code: "current-unreadable",
          message: `the current file ${read.issue.message}`,
        },
      };
}

function change(
  path: string | null,
  operation: ChangeOperation,
  result: Reconstruction | null,
  from: string | null = null,
): FileChange {
  return {
    path,
    operation,
    from,
    content: result?.ok ? result.content : null,
    problem:
      result && !result.ok
        ? { code: result.code, message: result.message }
        : null,
  };
}

const lookup = (path: string | null, context: PlanContext): CurrentFile =>
  path === null ? { state: "absent" } : context.current(path);

/** Reconstructs from the current text, unless it can't be read. */
function fromCurrent(
  file: CurrentFile,
  apply: (text: string | null) => Reconstruction,
): Reconstruction {
  const { text, problem } = currentText(file);
  return problem ? { ok: false, ...problem } : apply(text);
}

function claudeChange(
  request: Exclude<WriteRequest, { tool: "patch" }>,
  context: PlanContext,
) {
  const path = located(request.path, context);
  const file = lookup(path, context);
  const operation = file.state === "absent" ? "create" : "update";
  if (request.tool === "write")
    return change(path, operation, { ok: true, content: request.content });
  return change(
    path,
    operation,
    fromCurrent(file, (text) => applyClaudeEdit(text, request)),
  );
}

const missing: Reconstruction = {
  ok: false,
  code: "missing",
  message: "the file doesn't exist",
};

function patchChange(
  operation: PatchOperation,
  context: PlanContext,
): FileChange {
  const path = located(operation.path, context);
  const file = lookup(path, context);
  if (operation.kind === "add")
    return change(path, file.state === "absent" ? "create" : "update", {
      ok: true,
      content: operation.content,
    });
  if (operation.kind === "delete")
    return change(path, "delete", file.state === "absent" ? missing : null);
  const result = fromCurrent(file, (text) =>
    text === null ? missing : applyUpdate(text, operation.chunks),
  );
  if (operation.moveTo === null) return change(path, "update", result);
  return change(located(operation.moveTo, context), "move", result, path);
}

/** Every path a change touches, by how paths compare. */
const touched = (change: FileChange) =>
  [change.path, change.from]
    .filter((path): path is string => path !== null)
    .map(pathKey);

function distinct(changes: FileChange[]) {
  const seen = new Set<string>();
  for (const key of changes.flatMap(touched)) {
    if (seen.has(key))
      throw new Refusal("ambiguous", "the request touches one file twice");
    seen.add(key);
  }
}

/** The changes a request makes, or why it is refused as a whole. */
export function planWrite(request: WriteRequest, context: PlanContext): Plan {
  try {
    if (request.tool !== "patch")
      return { ok: true, changes: [claudeChange(request, context)] };
    const parsed = parsePatch(request.patch);
    if (!parsed.ok)
      return {
        ok: false,
        code: `patch-${parsed.code}`,
        message: parsed.message,
      };
    const changes = parsed.operations.map((operation) =>
      patchChange(operation, context),
    );
    distinct(changes);
    return { ok: true, changes };
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    return { ok: false, code: error.code, message: error.message };
  }
}
