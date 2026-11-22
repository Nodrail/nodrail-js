// A write checked against file contracts before it runs (DC-04.2): every
// file a request touches is planned and judged before any decision, so a
// multi-file patch passes only when each governed file passes. A governed
// file must be written by an allowed agent, have content that can be
// reconstructed exactly, and read valid against every contract governing
// it. A content contract never authorizes a delete, or a move out of its
// folder: those are refused here and need their own permission. Protected
// paths and paths an adapter found unsafe are refused, governed or not.
//
// A check reads the current files at one moment and the host writes at a
// later one, so unless a mediated writer re-checks the recorded revisions
// as it writes, the result is `preflight-only`. Nothing here is atomic.
import { sha256Hex } from "../shapes/digest.ts";
import { contractsFor, type FileContract } from "./contracts.ts";
import type { Guarantee } from "./limits.ts";
import { readFileContent, type FileReading } from "./parse.ts";
import {
  planWrite,
  type ChangeOperation,
  type CurrentFile,
  type FileChange,
} from "./plan.ts";
import type { WriteRequest } from "./requests.ts";
import type { FileIssue } from "./text.ts";

export type FileVerdict = {
  path: string | null;
  operation: ChangeOperation;
  from: string | null;
  /** Contracts governing the result (or, for a delete or move, the source). */
  contracts: string[];
  outcome: "pass" | "fail" | "not-governed";
  readings: FileReading[];
  issues: FileIssue[];
};

/** The state a mediated writer must still find before it writes. */
export type ExpectedRevision = {
  path: string;
  state: "absent" | "present";
  /** Null when the caller supplied bytes without one. */
  revision: string | null;
};

export type WriteCheck = {
  decision: "allow" | "deny" | "not-governed";
  /** `preflight-only` unless a mediated writer applies the write. */
  guarantee: Guarantee;
  /** Never true: a check and a write are two moments. */
  atomic: false;
  /** The first reason to deny, safe to show; null otherwise. */
  reason: string | null;
  files: FileVerdict[];
  expected: ExpectedRevision[];
};

export type WriteCheckInput = {
  request: WriteRequest;
  /** Absolute project folder, POSIX; or several spellings of that one folder. */
  projectRoot: string | string[];
  cwd: string;
  contracts: FileContract[];
  current: (path: string) => CurrentFile;
  /** The writing agent; null for the main session, which no `writers` list names. */
  agent: string | null;
  /** Paths existing guards protect (`data:` paths); a content contract doesn't open them. */
  isProtected?: (path: string) => boolean;
  /** True only when a mediated writer applies the write and re-checks `expected`. */
  mediated?: boolean;
};

const issue = (path: string, code: string, message: string): FileIssue => ({
  path,
  code,
  message,
});

function pathIssues(change: FileChange, input: WriteCheckInput) {
  const issues: FileIssue[] = [];
  for (const path of [change.from, change.path]) {
    if (path === null) continue;
    const current = input.current(path);
    if (current.state === "unsafe")
      issues.push(issue(path, "unsafe-path", current.reason));
    if (input.isProtected?.(path))
      issues.push(
        issue(
          path,
          "protected",
          "is protected; a file contract doesn't open it",
        ),
      );
  }
  return issues;
}

/** The source a delete or a move takes a file away from. */
const source = (change: FileChange) =>
  change.operation === "delete"
    ? change.path
    : change.operation === "move"
      ? change.from
      : null;

function contentIssues(
  change: FileChange & { path: string },
  governing: FileContract[],
  input: WriteCheckInput,
) {
  const issues: FileIssue[] = [];
  const readings: FileReading[] = [];
  for (const contract of governing)
    if (
      contract.writers &&
      (input.agent === null || !contract.writers.includes(input.agent))
    )
      issues.push(
        issue(
          contract.name,
          "writer",
          "this agent isn't one of the contract's writers",
        ),
      );
  if (change.content === null) {
    const problem = change.problem ?? {
      code: "unknown",
      message: "can't be reconstructed",
    };
    issues.push(issue(change.path, "unreconstructable", problem.message));
    return { issues, readings };
  }
  for (const contract of governing) {
    const reading = readFileContent(contract, change.content, change.path);
    readings.push(reading);
    if (reading.state === "invalid")
      issues.push(
        ...reading.issues.map((found) =>
          issue(`${contract.name}:${found.path}`, found.code, found.message),
        ),
      );
  }
  return { issues, readings };
}

function judge(change: FileChange, input: WriteCheckInput): FileVerdict {
  const issues = pathIssues(change, input);
  const from = source(change);
  const leaving = from === null ? [] : contractsFor(input.contracts, from);
  if (leaving.length)
    issues.push(
      issue(
        from!,
        "delete",
        "a file contract doesn't allow deleting or moving a file out; that needs its own permission",
      ),
    );
  const arriving =
    change.operation === "delete" || change.path === null
      ? []
      : contractsFor(input.contracts, change.path);
  let readings: FileReading[] = [];
  if (arriving.length) {
    const found = contentIssues(
      change as FileChange & { path: string },
      arriving,
      input,
    );
    issues.push(...found.issues);
    readings = found.readings;
  }
  const contracts = [...new Set([...leaving, ...arriving].map((c) => c.name))];
  const outcome = issues.length
    ? "fail"
    : contracts.length
      ? "pass"
      : "not-governed";
  const { path, operation } = change;
  return {
    path,
    operation,
    from: change.from,
    contracts,
    outcome,
    readings,
    issues,
  };
}

function expected(
  changes: FileChange[],
  input: WriteCheckInput,
): ExpectedRevision[] {
  const paths = changes
    .flatMap((c) => [c.from, c.path])
    .filter((p): p is string => p !== null);
  return paths.map((path) => {
    const current = input.current(path);
    if (current.state !== "present")
      return { path, state: "absent", revision: null };
    const revision =
      current.revision !== undefined
        ? current.revision
        : typeof current.content === "string"
          ? `sha256:${sha256Hex(current.content)}`
          : null;
    return { path, state: "present", revision };
  });
}

/** Whether a write may run, file by file, and what that answer guarantees. */
export function checkWrite(input: WriteCheckInput): WriteCheck {
  const guarantee: Guarantee = input.mediated ? "mediated" : "preflight-only";
  const base = { guarantee, atomic: false as const };
  const plan = planWrite(input.request, input);
  if (!plan.ok)
    return {
      ...base,
      decision: "deny",
      reason: `the write is refused: ${plan.message}`,
      files: [],
      expected: [],
    };
  const files = plan.changes.map((change) => judge(change, input));
  const failed = files.find((file) => file.outcome === "fail");
  const first = failed?.issues[0];
  const decision = failed
    ? "deny"
    : files.some((f) => f.outcome === "pass")
      ? "allow"
      : "not-governed";
  return {
    ...base,
    decision,
    reason: first ? `${first.path}: ${first.message}` : null,
    files,
    expected: expected(plan.changes, input),
  };
}
