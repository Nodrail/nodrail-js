import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pluginsField, type PluginSpec } from "@nodrail/policy-engine/yaml";
import { parse } from "yaml";
import type { Command } from "../context.ts";
import { CliError, UsageError } from "../io.ts";
import { folderHost } from "../project/host.ts";
import { MANIFEST_FILE } from "../project/lockfile.ts";
import { holdProject } from "../project/store.ts";
import {
  changesBetween,
  fetchPlugin,
  filesIn,
  writeFolder,
  type FolderChanges,
  type PluginFile,
} from "../setup/plugin-origin.ts";

/** Where nodrail writes for a host: never a plugin's folder. */
const SETUP_PLACES = [
  ".claude",
  ".claude-plugin",
  ".codex",
  ".agents",
  ".nodrail",
];

/** The plugins nodrail.yaml says come from git, by name. */
function pluginsFromGit(root: string) {
  let text: string;
  try {
    text = readFileSync(join(root, MANIFEST_FILE), "utf8");
  } catch {
    throw new CliError(`No ${MANIFEST_FILE} here.`);
  }
  const manifest = parse(text) as { plugins?: unknown } | null;
  const parsed = pluginsField.safeParse(manifest?.plugins ?? {});
  if (!parsed.success)
    throw new CliError(
      `${MANIFEST_FILE}'s plugins don't read; run \`nodrail plan\` to see why.`,
    );
  return Object.entries(parsed.data).filter(
    (
      entry,
    ): entry is [
      string,
      PluginSpec & { from: NonNullable<PluginSpec["from"]> },
    ] => entry[1].from !== undefined,
  );
}

/** The plugin's folder, as a project path nodrail may write. */
function folderOf(root: string, name: string, spec: PluginSpec) {
  const path = spec.source.replace(/^\.\//, "").replace(/\/+$/, "");
  const real = folderHost(root).real(path);
  if (
    path === "" ||
    real !== path ||
    SETUP_PLACES.some((place) => path === place || path.startsWith(`${place}/`))
  )
    throw new CliError(
      `Plugin ${name}: ${spec.source} isn't a folder of the project's own that nodrail may write.`,
    );
  return path;
}

const count = (changes: FolderChanges) =>
  changes.added.length + changes.changed.length + changes.removed.length;

function changeLines(changes: FolderChanges) {
  return [
    ...changes.added.map((path) => `    + ${path}`),
    ...changes.changed.map((path) => `    ~ ${path}`),
    ...changes.removed.map((path) => `    - ${path}`),
  ];
}

/**
 * `nodrail plugin fetch [name]`: copies each plugin nodrail.yaml says comes
 * from git into its folder, exactly as it is at the pinned commit, after
 * showing what changes and asking. `--check` compares and writes nothing:
 * exit 1 when a folder differs from its commit. The lock then shows the
 * files, like any change to the project.
 */
export async function plugin(command: Command) {
  const { io, values } = command;
  const [verb, only, ...rest] = command.args;
  if (verb !== "fetch" || rest.length > 0)
    throw new UsageError(
      "Usage: nodrail plugin fetch [<name>] [--check] [--yes]",
    );
  const root = io.cwd;
  const listed = pluginsFromGit(root).filter(
    ([name]) => only === undefined || name === only,
  );
  if (listed.length === 0)
    throw new CliError(
      only === undefined
        ? `No plugin in ${MANIFEST_FILE} says where it comes from (from: { git, commit }).`
        : `${MANIFEST_FILE} has no plugin ${only} with from: { git, commit }.`,
    );
  const fetched = listed.map(([name, spec]) => {
    const folder = folderOf(root, name, spec);
    const want = fetchPlugin(name, spec.from, io.env);
    const changes = changesBetween(filesIn(join(root, folder)), want);
    return { name, spec, folder, want, changes };
  });
  const differs = fetched.filter((each) => count(each.changes) > 0);
  command.print(
    {
      plugins: fetched.map(({ name, spec, folder, changes }) => ({
        name,
        folder,
        git: spec.from.git,
        commit: spec.from.commit,
        ...changes,
      })),
    },
    () =>
      fetched
        .flatMap(({ name, spec, folder, changes }) => [
          `${name}: ${spec.from.git} at ${spec.from.commit.slice(0, 12)}${spec.from.path ? `, ${spec.from.path}` : ""} → ./${folder}`,
          count(changes) === 0
            ? "    matches the commit"
            : changeLines(changes),
        ])
        .flat()
        .join("\n"),
  );
  if (values.check) {
    if (differs.length > 0)
      throw new CliError(
        `${differs.map((each) => each.name).join(", ")} differ${differs.length === 1 ? "s" : ""} from the pinned commit.`,
      );
    return;
  }
  if (differs.length === 0) return;
  if (!(await confirmed(command, differs.length))) {
    io.out("Nothing was changed.");
    return;
  }
  holdProject({ root, home: io.home }, () => {
    for (const each of differs) writeTo(root, each);
  });
  if (!values.json)
    io.out(
      "\nCopied. Next: `nodrail policy lock` shows the plugin's files for you to review, then `nodrail apply`.",
    );
}

function writeTo(
  root: string,
  each: { name: string; folder: string; want: Map<string, PluginFile> },
) {
  // What's there now, read again inside the hold.
  const changes = changesBetween(filesIn(join(root, each.folder)), each.want);
  writeFolder(join(root, each.folder), each.want, changes);
}

async function confirmed({ io, values }: Command, plugins: number) {
  if (values.yes) return true;
  if (!io.interactive)
    throw new UsageError(
      "`nodrail plugin fetch` asks before changing files. Run it at a terminal, or add --yes.",
    );
  const answer = await io.ask(
    `\nReplace ${plugins === 1 ? "this folder" : `these ${plugins} folders`} with the commit's files? [y/N] `,
  );
  return /^y(es)?$/i.test(answer.trim());
}
