import { parseAllDocuments } from "yaml";
import { canonicalId, type Catalog } from "./catalog.ts";
import { agentName } from "./names.ts";
import type { ProjectHost, ProjectInput } from "./project.ts";
import type { ProjectManifest } from "./project-manifest.ts";
import { joinPath } from "./project-paths.ts";
import { SETUP_PLACES } from "./project-team.ts";
import {
  resource,
  rolesProblems,
  teamProblems,
  type ProjectSetup,
  type Resource,
  type SetupBinding,
} from "./project-resources.ts";

/** What reading the setup needs from the resolver, and what it adds to. */
export type SetupContext = {
  host: ProjectHost;
  catalog: Catalog;
  setup: ProjectSetup;
  inputs: ProjectInput[];
  problem(ref: string, from: string, message: string): void;
};

const LEAVES = "The path leaves the project folder";
const WRITTEN =
  "nodrail apply writes there, so it can't be a source; keep it in a folder of your own";

/**
 * Whether nodrail writes this path for a host. A skill or instructions there
 * would be copied onto itself, then taken for nodrail's own file and one day
 * removed with it.
 */
const written = (path: string) =>
  SETUP_PLACES.some(
    (place) => path === place || path.startsWith(`${place}/`),
  ) && !path.startsWith("nodrail.");

/**
 * Reads nodrail.yaml's resources into `context.setup` and checks them. Returns
 * each binding that can apply, by the module id or Policy name it binds, for
 * the resolver to rename that policy's agents as it reads it.
 */
export function readSetup(
  context: SetupContext,
  manifest: ProjectManifest,
  path: string,
) {
  const { setup } = context;
  setup.runtime = manifest.runtime ?? null;
  setup.start = manifest.start ?? false;
  const refs = manifest.resources;
  for (const ref of typeof refs === "string" ? [refs] : (refs ?? []))
    resourceRef(context, ref, path);
  for (const team of setup.teams)
    for (const message of teamProblems(team, agentNames(setup)))
      context.problem(team.name, team.file, message);
  chooseTeam(context, manifest.team, path);
  return checkBindings(context);
}

const agentNames = (setup: ProjectSetup) =>
  new Set(setup.agents.map((agent) => agent.name));

/** The team's members, or every agent when there is no team. */
export const membersOf = (setup: ProjectSetup) =>
  new Set(setup.team?.members ?? agentNames(setup));

/** A path written in `file`, followed into the project; undefined if out. */
function inProject(context: SetupContext, file: string, ref: string) {
  const path = joinPath(file, ref);
  return path === null ? undefined : context.host.real(path);
}

function resourceRef(context: SetupContext, ref: string, from: string) {
  const { host } = context;
  const real = inProject(context, from, ref);
  if (real === undefined) return context.problem(ref, from, LEAVES);
  const text = host.read(real);
  if (text !== undefined) return resourceFile(context, real, text, from);
  const files = host.list?.(real);
  if (files === undefined)
    return context.problem(ref, from, "No such file or folder");
  for (const file of files) {
    const inside = host.real(file);
    const content = inside === undefined ? undefined : host.read(inside);
    if (inside === undefined || content === undefined)
      context.problem(file, from, LEAVES);
    else resourceFile(context, inside, content, from);
  }
}

function resourceFile(
  context: SetupContext,
  path: string,
  text: string,
  from: string,
) {
  const { setup } = context;
  if (setup.files.includes(path)) return;
  if (!/\.ya?ml$/.test(path))
    return context.problem(path, from, "Resource files end in .yaml");
  setup.files.push(path);
  context.inputs.push({ kind: "local", path, text });
  for (const document of parseAllDocuments(text)) {
    const [error] = document.errors;
    if (error) return context.problem(path, from, `Not YAML: ${error.message}`);
    const value = document.toJS() as unknown;
    if (value === null) continue;
    const parsed = resource.safeParse(value);
    if (parsed.success) declare(context, parsed.data, path);
    else {
      const issue = parsed.error.issues[0];
      const at = issue?.path.join(".") || "resource";
      context.problem(path, from, `${at}: ${issue?.message ?? "Not valid"}`);
    }
  }
}

function declare(context: SetupContext, item: Resource, file: string) {
  const { setup } = context;
  const name = item.metadata.name;
  const taken = {
    Agent: setup.agents,
    Team: setup.teams,
    Policy: setup.policies,
    PolicyBinding: setup.bindings,
  }[item.kind].some((earlier) => earlier.name === name);
  if (taken)
    return context.problem(name, file, `A second ${item.kind} named ${name}`);
  if (item.kind === "Agent") declareAgent(context, item, file);
  else if (item.kind === "Team") setup.teams.push({ name, file, ...item.spec });
  else if (item.kind === "Policy") {
    const source = inProject(context, file, item.spec.source);
    if (source === undefined)
      return context.problem(item.spec.source, file, LEAVES);
    setup.policies.push({ name, file, source });
  } else {
    const roles = Object.entries(item.spec.roles).map(
      ([role, agent]) => [agentName(role), agent] as const,
    );
    setup.bindings.push({
      name,
      file,
      policy: item.spec.policy,
      roles: Object.fromEntries(roles),
    });
  }
}

function declareAgent(
  context: SetupContext,
  item: Extract<Resource, { kind: "Agent" }>,
  file: string,
) {
  const { spec } = item;
  let instructions: string | null = null;
  if (spec.instructions !== undefined) {
    const path = inProject(context, file, spec.instructions);
    if (path === undefined) context.problem(spec.instructions, file, LEAVES);
    else if (written(path)) context.problem(spec.instructions, file, WRITTEN);
    else if (context.host.read(path) === undefined)
      context.problem(spec.instructions, file, "No such file");
    else instructions = path;
  }
  const skills: string[] = [];
  for (const ref of spec.skills) {
    const folder = inProject(context, file, ref.replace(/\/+$/, ""));
    // The SKILL.md itself may be a link: follow it too, so it can't lead out.
    const skill =
      folder === undefined
        ? undefined
        : context.host.real(`${folder}/SKILL.md`);
    if (folder === undefined || skill === undefined)
      context.problem(ref, file, LEAVES);
    else if (written(folder)) context.problem(ref, file, WRITTEN);
    else if (context.host.read(skill) === undefined)
      context.problem(ref, file, "No SKILL.md in that folder");
    else skills.push(folder);
  }
  context.setup.agents.push({
    name: item.metadata.name,
    file,
    description: spec.description ?? null,
    instructions,
    skills,
    model: spec.model ?? null,
  });
}

/** The team named, else the only one; a host can't start without one. */
function chooseTeam(
  context: SetupContext,
  named: string | undefined,
  path: string,
) {
  const { setup } = context;
  if (named !== undefined) {
    setup.team = setup.teams.find((team) => team.name === named) ?? null;
    if (setup.team === null)
      context.problem(named, path, `No Team named ${named}`);
  } else if (setup.teams.length === 1) setup.team = setup.teams[0]!;
  else if (setup.teams.length > 1)
    context.problem("team", path, "Say which team to start: team: <name>");
  if (setup.runtime !== null && setup.teams.length === 0)
    context.problem("runtime", path, `${setup.runtime} needs a Team to start`);
}

function checkBindings(context: SetupContext) {
  const { setup } = context;
  const bindings = new Map<string, SetupBinding>();
  const policies = new Set(setup.policies.map((policy) => policy.name));
  const members = membersOf(setup);
  for (const binding of setup.bindings) {
    if (binding.policy.startsWith("@"))
      binding.policy =
        canonicalId(context.catalog, binding.policy) ?? binding.policy;
    const target = binding.policy;
    const problem = bindings.has(target)
      ? `${target} is bound twice`
      : !target.startsWith("@") && !policies.has(target)
        ? `No Policy named ${target}`
        : null;
    if (problem) {
      context.problem(binding.name, binding.file, problem);
      continue;
    }
    for (const message of rolesProblems(binding, members))
      context.problem(binding.name, binding.file, message);
    bindings.set(target, binding);
  }
  for (const policy of setup.policies)
    if (!bindings.has(policy.name))
      context.problem(
        policy.name,
        policy.file,
        `Policy ${policy.name} isn't bound, so it does nothing; add a PolicyBinding`,
      );
  return bindings;
}
