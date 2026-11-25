import { randomUUID } from "node:crypto";
import { isMap, parseDocument } from "yaml";
import { ApiError, DEFAULT_URL } from "../api.ts";
import { looksLikeSession, normalizeUrl, resolveToken } from "../config.ts";
import { commandFor, type Command, type Values } from "../context.ts";
import { CliError, UsageError } from "../io.ts";
import { LOCK_FILE, lockText, MANIFEST_FILE } from "../project/lockfile.ts";
import {
  checkIntegrity,
  planProject,
  readProject,
} from "../project/project.ts";
import { reviewText } from "../project/review.ts";
import { writeInProgress, writeProject } from "../project/store.ts";
import { login, requireArg } from "./auth.ts";
import { plan } from "./setup.ts";

const recovery = "copy the command from Agents → Connect a project";

function displayOrigin(value: string | undefined) {
  if (!value) return "(URL missing)";
  try {
    return new URL(value).origin;
  } catch {
    return "(invalid URL)";
  }
}

export function connectionTarget(input: Pick<Command, "args" | "values">) {
  const { workspace, environment } = input.values;
  try {
    const url = normalizeUrl(requireArg(input, "the control plane URL"));
    const slug = /^[a-z0-9][a-z0-9-]{0,62}$/;
    if (
      !workspace ||
      !environment ||
      !slug.test(workspace) ||
      !slug.test(environment)
    )
      throw new UsageError(
        "Usage: nodrail connect <url> --workspace <slug> --environment <slug>",
      );
    return { url, workspace, environment };
  } catch (error) {
    if (!(error instanceof CliError) && !(error instanceof UsageError))
      throw error;
    const ErrorType = error instanceof UsageError ? UsageError : CliError;
    throw new ErrorType(
      `${error.message} Destination: ${workspace ?? "(workspace missing)"}/${environment ?? "(environment missing)"} at ${displayOrigin(input.args[0])}. To set the destination, ${recovery}.`,
    );
  }
}

function reviewedConnectionProject(root: string) {
  const project = readProject(root);
  const { manifest, lock } = project;
  if (manifest === null)
    throw new CliError(
      `No ${MANIFEST_FILE} here. Run from your project folder.`,
    );
  const current = planProject({ root, manifest, previous: lock });
  checkIntegrity(lock, current.lock);
  if (!lock || lockText(current.lock) !== lockText(lock))
    throw new CliError(
      [
        reviewText(
          {
            text: lock?.baseline ?? "",
            source: lock ? LOCK_FILE : "an empty policy",
          },
          current,
        ),
        "Run `nodrail policy lock` to review and record these changes, then run `nodrail connect` again.",
      ].join("\n"),
    );
  return { manifest, lock };
}

function proposedConnection(
  manifest: string,
  target: ReturnType<typeof connectionTarget>,
) {
  const document = parseDocument(manifest);
  if (document.errors.length || !isMap(document.contents))
    throw new CliError(`Fix the YAML in ${MANIFEST_FILE} and retry.`);
  const connect = document.get("connect", true);
  if (connect !== undefined && !isMap(connect))
    throw new CliError(
      `The connect block in ${MANIFEST_FILE} must be a mapping.`,
    );
  if (!document.has("id")) document.set("id", randomUUID());
  if (isMap(connect)) {
    const url = connect.get("url");
    const same =
      normalizeUrl(typeof url === "string" ? url : DEFAULT_URL) ===
        target.url &&
      connect.get("workspace") === target.workspace &&
      connect.get("environment") === target.environment;
    if (!same) connect.delete("credential");
  }
  for (const [key, value] of Object.entries({ ...target, decide: "cloud" }))
    document.setIn(["connect", key], value);
  return document.toString();
}

async function connectionIdentity(
  command: Command,
  target: ReturnType<typeof connectionTarget>,
) {
  const { io } = command;
  const values: Values = { ...target };
  const auth = await commandFor(io, values, [], "login");
  const token = await resolveToken(
    io.env,
    io.home,
    target.url,
    target.workspace,
  );
  if (token) {
    try {
      return await (await auth.api()).me();
    } catch (error) {
      if (
        !(error instanceof ApiError) ||
        error.status !== 401 ||
        token === io.env.NODRAIL_TOKEN?.trim()
      )
        throw error;
    }
  }
  await login({ ...auth, print: (_value, format) => command.say(format()) });
  return (await auth.api()).me();
}

async function visibleWorkspaces(
  command: Command,
  target: ReturnType<typeof connectionTarget>,
) {
  const auth = await commandFor(command.io, target, [], "login");
  const { io } = command;
  const token = await resolveToken(
    io.env,
    io.home,
    target.url,
    target.workspace,
  );
  const api = await auth.api();
  if (token && looksLikeSession(token))
    return (await api.cliWorkspaces()).items.map(({ slug }) => slug);
  // Scripted personal tokens belong to one workspace.
  const personal = await commandFor(io, { url: target.url }, [], "login");
  return [(await (await personal.api()).me()).workspace.slug];
}

async function validateDestination(
  command: Command,
  target: ReturnType<typeof connectionTarget>,
) {
  try {
    const me = await connectionIdentity(command, target);
    if (me.workspace?.slug !== target.workspace)
      throw new CliError("This login belongs to a different workspace.");
    if (!me.environments?.some(({ slug }) => slug === target.environment))
      throw new CliError(
        `Choose an environment in ${target.workspace}: ${me.environments?.map(({ slug }) => slug).join(", ") || "none"}.`,
      );
  } catch (error) {
    const workspaces = await visibleWorkspaces(command, target).catch(
      () => null,
    );
    const detail = error instanceof Error ? error.message : String(error);
    throw new CliError(
      `Couldn't connect to ${target.workspace}/${target.environment} at ${target.url}: ${detail}${workspaces ? `\nWorkspaces this login can see: ${workspaces.join(", ") || "none"}.` : ""}\nTo set the destination, ${recovery}.`,
    );
  }
}

export async function connectProject(command: Command) {
  const target = connectionTarget(command);
  const { io } = command;
  const place = { root: io.cwd, home: io.home };
  if (writeInProgress(place))
    throw new CliError(
      "Run nodrail policy lock to settle the interrupted project write, then retry connect.",
    );
  const original = reviewedConnectionProject(place.root);
  const manifest = proposedConnection(original.manifest, target);
  const lock = planProject({
    root: place.root,
    manifest,
    previous: original.lock,
  }).lock;
  await validateDestination(command, target);
  await plan({ ...command, args: [] }, { manifest, lock });

  if (manifest === original.manifest) return;
  writeProject(place, () => {
    const current = reviewedConnectionProject(place.root);
    if (
      current.manifest !== original.manifest ||
      lockText(current.lock) !== lockText(original.lock)
    )
      throw new CliError(
        "The project changed during preflight. Run nodrail connect again.",
      );
    return { [MANIFEST_FILE]: manifest, [LOCK_FILE]: lockText(lock) };
  });
  command.say(
    `Updated ${MANIFEST_FILE} for ${target.workspace}/${target.environment} at ${target.url}.`,
  );
}
