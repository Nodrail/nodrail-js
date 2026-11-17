import {
  compilePolicies,
  permissionChanges,
  renderPermissionChanges,
  type ModuleUse,
} from "@nodrail/policy-engine/yaml";
import { spawnSync } from "node:child_process";
import { lineDiff } from "../diff.ts";
import { LOCK_FILE, readLock, sha256, type Lock } from "./lockfile.ts";
import type { ProjectPlan } from "./project.ts";

const indent = (text: string) =>
  text
    .replace(/\n$/, "")
    .split("\n")
    .map((line) => `  ${line}`);

/** The policy a change is compared with, and where it came from. */
export type Baseline = { text: string; source: string };

const git = (root: string, args: string[]) =>
  spawnSync("git", args, { cwd: root, encoding: "utf8" });

/**
 * What the change is compared with. In a git repository, the lock as last
 * committed: an agent that can edit the working tree can't make a weakening
 * look like no change. Elsewhere, the lock on disk, only if it is whole.
 */
export function reviewBaseline(root: string, onDisk: Lock | null): Baseline {
  const committed = git(root, ["show", `HEAD:./${LOCK_FILE}`]);
  if (committed.status === 0) {
    const lock = readLock(committed.stdout);
    return typeof lock === "string"
      ? {
          text: "",
          source: `nothing: the committed ${LOCK_FILE} can't be read`,
        }
      : { text: lock.baseline, source: `the last committed ${LOCK_FILE}` };
  }
  if (git(root, ["rev-parse", "--is-inside-work-tree"]).status === 0)
    return { text: "", source: `nothing yet: ${LOCK_FILE} isn't committed` };
  if (!onDisk?.effective)
    return { text: "", source: "nothing yet: no policy was in effect" };
  return sha256(onDisk.baseline) === onDisk.effective.sha256
    ? {
        text: onDisk.baseline,
        source: `${LOCK_FILE} on disk (not a git repository)`,
      }
    : {
        text: "",
        source: `nothing: ${LOCK_FILE} on disk doesn't hold its own review`,
      };
}

/** The document last reviewed, or null before the first one. */
function reviewed(baseline: Baseline) {
  if (!baseline.text) return null;
  const result = compilePolicies([
    { name: "baseline.apf.yaml", text: baseline.text },
  ]);
  return result.ok ? result.document : null;
}

/** A waiting module's own policy files, as they would be added. */
function pendingSources(plan: ProjectPlan, use: ModuleUse) {
  const rules = plan.resolution.inputs.filter(
    (input) =>
      input.kind === "catalog" &&
      input.id === use.id &&
      !/^kind: nodrail\.module\//m.test(input.text),
  );
  return [
    `${use.id}@${use.version}: not in effect until it has ${use.missing.join(", ")}. Its rules:`,
    ...rules.flatMap((input) => [
      `  ${input.path}`,
      ...input.text
        .replace(/\n$/, "")
        .split("\n")
        .map((line) => `    + ${line}`),
    ]),
  ];
}

/**
 * What the change does, for the person about to commit it: who gains or
 * loses which actions since the last review, then the effective policy's
 * lines. A module still waiting for values shows its own files instead,
 * since nothing of it is in effect yet.
 */
export function reviewText(baseline: Baseline, plan: ProjectPlan) {
  const lines: string[] = [];
  if (plan.effective) {
    const changes = permissionChanges(
      reviewed(baseline),
      plan.effective.document,
    );
    lines.push(
      `Permissions, compared with ${baseline.source}:`,
      ...indent(renderPermissionChanges(changes)),
    );
    const diff = lineDiff(baseline.text, plan.effective.text);
    if (diff.length > 0)
      lines.push("Effective policy:", ...diff.map((line) => `  ${line}`));
  } else {
    lines.push("Permissions: pending until every module has its values.");
  }
  for (const use of plan.pending) lines.push(...pendingSources(plan, use));
  return lines.join("\n");
}
