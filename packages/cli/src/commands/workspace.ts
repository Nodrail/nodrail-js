import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import type { IntendedRevision } from "../api.ts";
import type { Command } from "../context.ts";
import { CliError, confirm, UsageError } from "../io.ts";
import {
  LOCK_FILE,
  MANIFEST_FILE,
  readLock,
  type Lock,
} from "../project/lockfile.ts";
import { readState, type Runtime } from "../setup/state.ts";

/**
 * `nodrail workspace publish|show`: the team's intended revision (W4.3).
 * Publishing records the project's locked workspace revision as the one
 * the environment should run: its digest and the lock's file list, never
 * a file's contents (git carries those). `show` compares it with the lock
 * here and with what each host was last applied from.
 */

const short = (sha: string | null | undefined) =>
  sha ? sha.slice(0, 12) : "none";

function lockOf(
  root: string,
): Lock & { workspace: NonNullable<Lock["workspace"]> } {
  let text: string;
  try {
    text = readFileSync(join(root, LOCK_FILE), "utf8");
  } catch {
    throw new CliError(
      `No ${LOCK_FILE} here. Run \`nodrail policy lock\` first.`,
    );
  }
  const lock = readLock(text);
  if (typeof lock === "string") throw new CliError(lock);
  if (!lock.workspace)
    throw new CliError(
      `${LOCK_FILE} locks a policy only, not a workspace. Run \`nodrail policy lock\` in a project that sets up a team.`,
    );
  return lock as Lock & { workspace: NonNullable<Lock["workspace"]> };
}

/** The project as the team view names it: its folder's name, as observations do. */
const projectName = (root: string) => basename(realpathSync(root));

const idOf = z.object({ id: z.uuid().optional() });

/**
 * The project as the team view knows it: by the stable `id` in nodrail.yaml,
 * its name only for display. Without an id, two unrelated projects with the
 * same folder name would share one intended revision, so there is none.
 */
function projectOf(root: string) {
  let id: string | undefined;
  try {
    id = idOf.parse(
      parse(readFileSync(join(root, MANIFEST_FILE), "utf8")) ?? {},
    ).id;
  } catch {
    id = undefined;
  }
  if (!id)
    throw new CliError(
      `${MANIFEST_FILE} has no id, so the team view can't tell this project from another of the same name. Add \`id: ${randomUUID()}\` to it, lock and commit, then run this again.`,
    );
  return { id, name: projectName(root) };
}

function revisionBody(root: string) {
  const project = projectOf(root);
  const lock = lockOf(root);
  const files = [lock.manifest, ...lock.files, ...lock.workspace.files];
  const unique = [...new Map(files.map((file) => [file.path, file])).values()];
  return {
    project: project.name,
    project_id: project.id,
    revision: lock.workspace.sha256,
    policy_revision: lock.effective?.sha256 ?? null,
    files: unique.map(({ path, sha256 }) => ({ path, sha256 })),
  };
}

function rootOf(command: Command, rest: string[]) {
  if (rest.length > 1) throw new UsageError(`Unexpected "${rest[1]}".`);
  return resolve(command.io.cwd, rest[0] ?? ".");
}

async function publish(command: Command, root: string) {
  const { io, values } = command;
  if (!values.yes && !io.interactive)
    throw new UsageError(
      "Publishing needs a person to confirm. Run it at a terminal, or pass --yes.",
    );
  const body = revisionBody(root);
  const api = await command.api();
  const { revision: current } = await api.intendedRevision(body.project_id);
  if (current?.revision === body.revision) {
    command.print(
      { published: null, revision: current },
      () =>
        `${body.project} already intends workspace ${short(body.revision)}.`,
    );
    return;
  }
  command.say(
    `${body.project}: intended workspace ${short(current?.revision)} → ${short(body.revision)} (${body.files.length} files, digests only).`,
  );
  if (
    !values.yes &&
    !(await confirm(io, "Publish it as the revision your team should run?"))
  )
    throw new CliError("Nothing was published.");
  const published = await api.publishRevision(body);
  command.print(
    published,
    () =>
      `Published workspace ${short(published.revision.revision)} for ${body.project}.`,
  );
}

function hostLines(root: string, intended: IntendedRevision | null) {
  const hosts = readState(root)?.hosts ?? {};
  return (Object.keys(hosts) as Runtime[]).map((host) => {
    const applied = hosts[host]?.revision?.workspace ?? null;
    const word =
      intended === null
        ? ""
        : applied === intended.revision
          ? ", as intended"
          : ", behind";
    return `  ${host}: applied from ${short(applied)}${word}`;
  });
}

async function show(command: Command, root: string) {
  const { id, name: project } = projectOf(root);
  const { revision } = await (await command.api()).intendedRevision(id);
  const locked = lockOf(root).workspace.sha256;
  command.print({ project, intended: revision, locked }, () =>
    [
      revision
        ? `${project}: your team intends workspace ${short(revision.revision)}, published by ${revision.published_by} at ${revision.published_at}.`
        : `${project}: no revision published yet. Run \`nodrail workspace publish\` to make the lock here the one.`,
      `  lock here: ${short(locked)}${revision ? (locked === revision.revision ? ", as intended" : ", differs: pull, or publish it") : ""}`,
      ...hostLines(root, revision),
    ].join("\n"),
  );
}

export async function workspace(command: Command) {
  const [action, ...rest] = command.args;
  if (action === "publish") return publish(command, rootOf(command, rest));
  if (action === "show") return show(command, rootOf(command, rest));
  throw new UsageError(
    "Use `nodrail workspace publish [folder]` or `nodrail workspace show [folder]`.",
  );
}
