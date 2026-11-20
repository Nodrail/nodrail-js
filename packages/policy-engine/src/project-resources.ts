import { z } from "zod";
import type { AgentConnections, ConnectionSpec } from "./connections.ts";
import type { AgentPlugins, PluginSpec } from "./plugins.ts";
import type { Runtime, Tested } from "./project-manifest.ts";
import type { Telemetry } from "./telemetry-schema.ts";
import { localRef, resourceName } from "./project-manifest.ts";

/**
 * The setup's typed resources, Kubernetes style: each document says its
 * `apiVersion` and `kind`, names itself in `metadata`, and describes what it
 * wants in `spec`. Agent ≈ ServiceAccount, Team ≈ who may hand work to whom,
 * Policy ≈ Role, PolicyBinding ≈ RoleBinding. Modules stay in the manifest's
 * `imports`, with the catalog and the lock.
 */
export const RESOURCE_API = "apf.nodrail.com/v1alpha1";

const metadata = z.object({ name: resourceName }).strict();

const markdownRef = localRef.refine((path) => path.endsWith(".md"), {
  message: "A .md file",
});
const yamlRef = localRef.refine((path) => /\.ya?ml$/.test(path), {
  message: "A .yaml file",
});

const agentSpec = z
  .object({
    /** When the host should hand work to it; hosts show it to the model. */
    description: z.string().min(1).max(1000).optional(),
    /** Its own instructions, the body of the host's agent file. */
    instructions: markdownRef.optional(),
    /** Folders that each hold a SKILL.md. */
    skills: z.array(localRef).max(20).default([]),
    model: z.string().min(1).max(100).optional(),
  })
  .strict();

const teamSpec = z
  .object({
    /** The agent a session starts as. */
    entry: resourceName,
    members: z.array(resourceName).min(1).max(50),
    /** Who may start whom. Nothing else may be started. */
    handoffs: z
      .array(z.object({ from: resourceName, to: resourceName }).strict())
      .max(200)
      .default([]),
  })
  .strict();

const policySpec = z.object({ source: yamlRef }).strict();

const bindingSpec = z
  .object({
    /** A Policy's name, or a module the manifest imports, like @nodrail/x. */
    policy: z.string().min(1).max(200),
    /** Each role the policy names, to the agent that plays it. */
    roles: z.record(z.string().min(1).max(63), resourceName).default({}),
  })
  .strict();

const typed = <K extends string, S extends z.ZodType>(kind: K, spec: S) =>
  z
    .object({
      apiVersion: z.literal(RESOURCE_API),
      kind: z.literal(kind),
      metadata,
      spec,
    })
    .strict();

export const resource = z.discriminatedUnion("kind", [
  typed("Agent", agentSpec.prefault({})),
  typed("Team", teamSpec),
  typed("Policy", policySpec),
  typed("PolicyBinding", bindingSpec),
]);
export type Resource = z.infer<typeof resource>;
export type ResourceKind = Resource["kind"];
export const RESOURCE_KINDS: readonly ResourceKind[] = [
  "Agent",
  "Team",
  "Policy",
  "PolicyBinding",
];

/** Where a resource was declared, for messages and for its relative paths. */
type Declared = { name: string; file: string };

export type SetupAgent = Declared & {
  description: string | null;
  /** Project paths, resolved from the resource file. */
  instructions: string | null;
  skills: string[];
  model: string | null;
};
export type SetupTeam = Declared & {
  entry: string;
  members: string[];
  handoffs: { from: string; to: string }[];
};
export type SetupPolicy = Declared & { source: string };
export type SetupBinding = Declared & {
  policy: string;
  roles: Record<string, string>;
};

/** A tool connection, with the project files it runs. */
export type SetupConnection = {
  name: string;
  spec: ConnectionSpec;
  /** Project paths its arguments name, locked and kept from agents. */
  files: string[];
  /** Project paths of what it keeps, reached only through it; not locked. */
  data?: string[];
};

export type SetupPlugin = {
  name: string;
  spec: PluginSpec;
  /** Its folder, as a project path: locked and kept from agents. */
  folder: string;
  /** The hosts it has a manifest for. */
  hosts: Runtime[];
  /** The version each host's manifest gives, where it gives one. */
  versions: Partial<Record<Runtime, string>>;
};

/** What nodrail.yaml and its resources ask a host to be. */
export type ProjectSetup = {
  /** The project's stable id for reports, when nodrail.yaml gives one. */
  id: string | null;
  /** The host to set up, when only one is named. */
  runtime: Runtime | null;
  /** Every host the setup is for: `runtime`, or each one `runtimes` lists. */
  runtimes: Runtime[];
  start: boolean;
  /** The team a session starts with, or null when there is none. */
  team: SetupTeam | null;
  agents: SetupAgent[];
  teams: SetupTeam[];
  policies: SetupPolicy[];
  bindings: SetupBinding[];
  connections: SetupConnection[];
  /** Who may use which connection; null when every member may. */
  agentConnections: AgentConnections | null;
  /** Plugins in the project each host loads. */
  plugins: SetupPlugin[];
  /** Who may use which plugin; null when every member may. */
  agentPlugins: AgentPlugins | null;
  /** Where decisions are sent, or null when nowhere. */
  telemetry: Telemetry | null;
  /** The exact versions the workspace was tested with, or null. */
  tested: Tested | null;
  /** What observation records, and whether it runs at session start. */
  observe: { names: boolean; sessionStart: boolean };
  /** The resource files, in the order they were read. */
  files: string[];
};

export const emptySetup = (): ProjectSetup => ({
  id: null,
  runtime: null,
  runtimes: [],
  start: false,
  team: null,
  agents: [],
  teams: [],
  policies: [],
  bindings: [],
  connections: [],
  agentConnections: null,
  plugins: [],
  agentPlugins: null,
  telemetry: null,
  tested: null,
  observe: { names: false, sessionStart: true },
  files: [],
});

/** What's wrong with a team, given the agents declared. */
export function teamProblems(team: SetupTeam, agents: ReadonlySet<string>) {
  const problems: string[] = [];
  const members = new Set(team.members);
  if (members.size !== team.members.length)
    problems.push("Lists a member twice");
  for (const member of team.members)
    if (!agents.has(member)) problems.push(`No Agent named ${member}`);
  if (!members.has(team.entry))
    problems.push(`Its entry ${team.entry} isn't a member`);
  const seen = new Set<string>();
  for (const { from, to } of team.handoffs) {
    for (const end of [from, to])
      if (!members.has(end))
        problems.push(`Hands off with ${end}, who isn't a member`);
    if (from === to) problems.push(`${from} hands off to itself`);
    if (seen.has(`${from}>${to}`)) problems.push(`Lists ${from} → ${to} twice`);
    seen.add(`${from}>${to}`);
  }
  return problems;
}

/**
 * What's wrong once a bound policy has been read: a role it maps that the
 * policy never names, likely a typo, and a name it uses that no agent plays.
 */
export function unplayedRoles(
  binding: SetupBinding,
  used: ReadonlySet<string>,
  members: ReadonlySet<string>,
) {
  const problems: string[] = [];
  const mapped = (name: string) => Object.hasOwn(binding.roles, name);
  for (const role of Object.keys(binding.roles))
    if (!used.has(role))
      problems.push(`${binding.policy} names no role ${role}`);
  // A name the policy uses and no role maps stays as it is: that agent plays it.
  const players = new Map<string, string>();
  for (const name of [...used].sort()) {
    if (!mapped(name) && !members.has(name)) {
      problems.push(
        `${binding.policy} names ${name}, which no agent plays; add ${name} to roles`,
      );
      continue;
    }
    const agent = mapped(name) ? binding.roles[name]! : name;
    const earlier = players.get(agent);
    if (earlier !== undefined)
      problems.push(
        `${binding.policy}'s ${earlier} and ${name} would both be ${agent}; one agent would vouch for itself`,
      );
    players.set(agent, name);
  }
  return problems;
}

/** What's wrong with a binding's roles before its policy is read. */
export function rolesProblems(
  binding: SetupBinding,
  members: ReadonlySet<string>,
) {
  // Two names going to one agent are found once the policy is read, with
  // the names it uses unmapped: see unplayedRoles.
  return Object.entries(binding.roles).flatMap(([role, agent]) =>
    members.has(agent)
      ? []
      : [`Role ${role} goes to ${agent}, who isn't on the team`],
  );
}
