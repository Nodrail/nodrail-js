import {
  canonicalId,
  catalogEntry,
  ENGINE_VERSION,
  parseModuleRef,
  type CatalogModule,
} from "@nodrail/policy-engine/yaml";
import { parse } from "yaml";
import type { Command } from "../context.ts";
import { CliError, UsageError, type Io } from "../io.ts";
import { bundledCatalog } from "../project/catalog.ts";
import {
  LOCK_FILE,
  lockText,
  MANIFEST_FILE,
  sha256,
} from "../project/lockfile.ts";
import { NEW_MANIFEST, withImport } from "../project/manifest-edit.ts";
import {
  checkIntegrity,
  planProject,
  readProject,
  type ProjectPlan,
} from "../project/project.ts";
import { reviewBaseline, reviewText } from "../project/review.ts";
import { writeInProgress, writeProject } from "../project/store.ts";

type Wanted = {
  entry: { ref: string; with?: Record<string, string> };
  pins?: Record<string, string>;
  label: string;
};

/** The values a module takes, each empty until the project gives it. */
function valuesOf(module: CatalogModule) {
  const manifest = parse(module.files["module.yaml"] ?? "") as {
    parameters?: Record<string, unknown>;
  } | null;
  const names = Object.keys(manifest?.parameters ?? {});
  return names.length > 0
    ? { with: Object.fromEntries(names.map((name) => [name, ""])) }
    : {};
}

/** What `nodrail add <ref>` asks for, in the form the manifest records. */
function wanted(ref: string): Wanted {
  if (ref.startsWith("./") || ref.startsWith("../")) {
    if (!/\.ya?ml$/.test(ref))
      throw new UsageError("A local import is a .yaml file.");
    return { entry: { ref }, label: ref };
  }
  if (!ref.startsWith("@"))
    throw new UsageError(
      "Add a catalog module, like @nodrail/open-reviewed-pr, or a file in this project, like ./policies/team.yaml.",
    );
  const found = catalogEntry(bundledCatalog(), ref);
  if ("problem" in found) throw new CliError(`${ref}: ${found.problem}`);
  const { id, version } = found.module;
  const asked = parseModuleRef(ref).version;
  return {
    entry: { ref: id, ...valuesOf(found.module) },
    pins: asked ? { [id]: version } : undefined,
    label: `${id}@${version}`,
  };
}

/** One line per module still waiting for a value. */
const waiting = (plan: ProjectPlan) =>
  plan.pending.map(
    (use) =>
      `  ${use.id}: configuration required. Set ${use.missing.map((name) => `with.${name}`).join(", ")} in ${MANIFEST_FILE}.`,
  );

function nextStep(plan: ProjectPlan) {
  return plan.pending.length > 0
    ? `Next: give the values in ${MANIFEST_FILE}, then run \`nodrail policy lock\`.`
    : "Next: commit nodrail.yaml and nodrail.lock.yaml, then `nodrail policy export --frozen` for your adapters.";
}

const NOT_ACTIVE =
  "This changes the project's files only. Agents follow it once you activate an export for them.";

export async function add(command: Command) {
  const [ref, ...rest] = command.args;
  if (!ref || rest.length > 0)
    throw new UsageError("Usage: nodrail add <@nodrail/module | ./file.yaml>");
  const asked = wanted(ref);
  const { io } = command;
  const root = io.cwd;
  const catalog = bundledCatalog();
  const same = (existing: string) =>
    existing === asked.entry.ref ||
    (existing.startsWith("@") &&
      canonicalId(catalog, parseModuleRef(existing).name) === asked.entry.ref);
  let report: string[] = [];
  writeProject({ root, home: io.home }, () => {
    const project = readProject(root);
    const edit = withImport(
      project.manifest ?? NEW_MANIFEST,
      asked.entry,
      same,
    );
    const plan = planProject({
      root,
      manifest: edit.text,
      previous: project.lock,
      pins: asked.pins,
      catalog,
    });
    if (project.lock) checkIntegrity(project.lock, plan.lock);
    const next = lockText(plan.lock);
    const files: Record<string, string> = {};
    if (edit.text !== project.manifest) files[MANIFEST_FILE] = edit.text;
    if (next !== project.lockText) files[LOCK_FILE] = next;
    report = [
      edit.added
        ? `Added ${asked.label}`
        : `${asked.label} is already in ${MANIFEST_FILE}`,
      Object.keys(files).length > 0
        ? `Changed: ${Object.keys(files).join(", ")}`
        : "Nothing changed.",
      ...waiting(plan),
      ...(Object.keys(files).length > 0
        ? [reviewText(reviewBaseline(root, project.lock), plan), NOT_ACTIVE]
        : []),
      nextStep(plan),
    ];
    return files;
  });
  io.out(report.join("\n"));
}

/** `nodrail policy lock`: review what changed since the last lock and record it. */
export async function lock(args: string[], io: Io) {
  if (args.length > 0) throw new UsageError("Usage: nodrail policy lock");
  const root = io.cwd;
  let report: string[] = [];
  writeProject({ root, home: io.home }, () => {
    const project = readProject(root);
    if (project.manifest === null)
      throw new CliError(
        `No ${MANIFEST_FILE} here. Start with \`nodrail add <module>\`.`,
      );
    const plan = planProject({
      root,
      manifest: project.manifest,
      previous: project.lock,
    });
    if (project.lock) checkIntegrity(project.lock, plan.lock);
    const next = lockText(plan.lock);
    const baseline = reviewBaseline(root, project.lock);
    if (next === project.lockText) {
      // Up to date on disk, but maybe not what was last committed: whoever
      // locked it, show what changed since.
      const since =
        plan.effective && plan.effective.text !== baseline.text
          ? [reviewText(baseline, plan)]
          : [];
      report = [`${LOCK_FILE} is up to date.`, ...waiting(plan), ...since];
      return null;
    }
    report = [
      `Updated ${LOCK_FILE}`,
      ...waiting(plan),
      reviewText(baseline, plan),
      NOT_ACTIVE,
      nextStep(plan),
    ];
    return { [LOCK_FILE]: next };
  });
  io.out(report.join("\n"));
  return 0;
}

/** Why the files on disk are not the ones the lock recorded, or null. */
function drift(locked: ProjectPlan["lock"], now: ProjectPlan["lock"]) {
  for (const file of now.files) {
    const before = locked.files.find((entry) => entry.path === file.path);
    if (!before) return `${file.path} is not in ${LOCK_FILE}`;
    if (before.sha256 !== file.sha256)
      return `${file.path} changed since it was locked`;
  }
  const gone = locked.files.find(
    (file) => !now.files.some((entry) => entry.path === file.path),
  );
  if (gone) return `${gone.path} is in ${LOCK_FILE} but no longer imported`;
  if (JSON.stringify(locked.modules) !== JSON.stringify(now.modules))
    return "The catalog modules differ from the lock";
  if (
    JSON.stringify([locked.edges, locked.order]) !==
    JSON.stringify([now.edges, now.order])
  )
    return "The import order differs from the lock";
  if (locked.engine !== now.engine)
    return `The lock was made for engine level ${locked.engine}; this nodrail has ${now.engine}`;
  if (JSON.stringify(locked.effective) !== JSON.stringify(now.effective))
    return "The effective policy differs from the lock";
  return null;
}

/**
 * `nodrail policy export --frozen`: the locked policy as one APF file on
 * stdout, offline, only when every file still matches the lock. Anything
 * else exits nonzero with the reason on stderr and nothing on stdout.
 */
export async function exportFrozen(args: string[], io: Io) {
  if (args.length !== 1 || args[0] !== "--frozen")
    throw new UsageError(
      "Export reads only a reviewed lock: use `nodrail policy export --frozen`.",
    );
  const { text } = frozenPolicy({ root: io.cwd, home: io.home });
  io.out(text.replace(/\n$/, ""));
  return 0;
}

/**
 * The locked policy as one APF file, offline, only when every file still
 * matches the lock; otherwise a CliError that says why and what to run.
 */
/** What a setup is made from: its resources, and every local file read. */
export const setupOf = (plan: ProjectPlan) => ({
  setup: plan.resolution.setup,
  inputs: plan.resolution.inputs.flatMap((input) =>
    input.kind === "local" ? [input.path] : [],
  ),
});

export function frozenPolicy({
  root,
  home,
  held = false,
}: {
  root: string;
  home: string;
  /** This process holds the project, so its own write isn't someone else's. */
  held?: boolean;
}) {
  if (!held && writeInProgress({ root, home }))
    throw new CliError(
      "A change to this project was interrupted or is under way. Run `nodrail policy lock` or `nodrail apply` to settle it.",
    );
  const project = readProject(root);
  if (project.manifest === null)
    throw new CliError(`No ${MANIFEST_FILE} here.`);
  if (project.lock === null)
    throw new CliError(
      `No ${LOCK_FILE} here. Run \`nodrail policy lock\` and commit it.`,
    );
  if (project.lock.engine > ENGINE_VERSION)
    throw new CliError(
      `${LOCK_FILE} needs engine level ${project.lock.engine}; this nodrail supports ${ENGINE_VERSION}. Update nodrail.`,
    );
  if (sha256(project.manifest) !== project.lock.manifest.sha256)
    throw new CliError(
      `${MANIFEST_FILE} changed since it was locked. Run \`nodrail policy lock\` to review the change.`,
    );
  const plan = planProject({
    root,
    manifest: project.manifest,
    previous: project.lock,
  });
  checkIntegrity(project.lock, plan.lock);
  if (plan.pending.length > 0)
    throw new CliError(
      ["Configuration required:", ...waiting(plan)].join("\n"),
    );
  const problem = drift(project.lock, plan.lock);
  if (problem)
    throw new CliError(`${problem}. Run \`nodrail policy lock\` to review it.`);
  return { text: plan.effective!.text, ...setupOf(plan) };
}
