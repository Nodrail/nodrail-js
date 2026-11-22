import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { accountableFiles } from "./accountable.ts";
import { connectionsFile, telemetrySettings } from "./connections.ts";
import type { Env } from "../config.ts";
import type { CompiledContracts } from "../contracts/engine.ts";
import { briefSection } from "../contracts/brief.ts";
import { receiptSection, withSection } from "../contracts/render.ts";
import {
  COPILOT_PLACES,
  SETUP_PLACES,
  type ProjectSetup,
  type SetupAgent,
  type SetupTeam,
} from "@nodrail/policy-engine/yaml";

/** Where the effective policy goes, for the hook to read. */
export const EFFECTIVE_FILE = ".nodrail/effective.yaml";

/** The files the hook keeps from being changed, from the project folder. */
export const PROTECT_LIST = ".nodrail/protected.txt";

/** A file nodrail writes whole and owns. */
export type DesiredFile = { path: string; content: Buffer; why: string };

const MAX_SKILL_FILES = 200;
const MAX_SKILL_BYTES = 1_000_000;

/**
 * What every host gets from a team: its members, the skills they use copied
 * under `skillsFolder`, and the effective policy. Each host adds its own
 * agent files and hook around this.
 */
export function teamFiles(input: {
  root: string;
  setup: ProjectSetup;
  effective: string;
  /** Every local file the policy was read from. */
  inputs: string[];
  skillsFolder: string;
  /** The declared contracts (preview), whose receipts agent files describe. */
  contracts?: CompiledContracts | null;
  /** Where the hook asks Cloud about evidence (NODRAIL_URL). */
  env?: Env;
}) {
  const { root, setup, effective, skillsFolder } = input;
  const team = setup.team!;
  const problems: string[] = [];
  const folders = new Map<string, string>();
  const members = setup.agents.filter((agent) =>
    team.members.includes(agent.name),
  );
  /** Each member's skills, by the name the host knows them by. */
  const skills = new Map<string, string[]>();
  for (const agent of members)
    skills.set(
      agent.name,
      agent.skills.map((folder) => {
        const name = folder.split("/").pop()!;
        const earlier = folders.get(name);
        if (earlier !== undefined && earlier !== folder)
          problems.push(
            `Two skills are named ${name}: ${earlier} and ${folder}. Rename one folder.`,
          );
        folders.set(name, folder);
        return name;
      }),
    );
  const files: DesiredFile[] = [];
  for (const [name, folder] of folders)
    files.push(
      ...skillFiles(root, folder, `${skillsFolder}/${name}`, problems),
    );
  files.push(
    {
      path: EFFECTIVE_FILE,
      content: Buffer.from(effective),
      why: "the effective policy the hook reads",
    },
    {
      path: PROTECT_LIST,
      content: Buffer.from(
        protectList(
          {
            inputs: input.inputs,
            connectionFiles: input.setup.connections.flatMap(
              (each) => each.files,
            ),
            pluginFolders: input.setup.plugins.map((each) => each.folder),
          },
          members,
        ),
      ),
      why: "the setup's files, which the hook keeps from agents",
    },
  );
  const connections = connectionsFile(input.setup, input.contracts ?? null);
  if (connections) files.push(connections);
  const telemetry = telemetrySettings(root, input.setup);
  if (telemetry) files.push(telemetry);
  files.push(...accountableFiles(input));
  return {
    team,
    members,
    skills,
    files,
    problems,
    body: (agent: SetupAgent) =>
      agentBody(root, team, input.contracts ?? null, agent),
    skipped: setup.agents
      .filter((agent) => !team.members.includes(agent.name))
      .map((agent) => agent.name),
  };
}

/**
 * An agent file's body: its instructions, then the briefs of the agents it
 * starts and its own receipt, each section only when there is one.
 */
function agentBody(
  root: string,
  team: SetupTeam,
  contracts: CompiledContracts | null,
  agent: SetupAgent,
) {
  return withSection(
    instructionsOf(root, agent, team.name),
    [
      briefSection(contracts, team, agent.name),
      receiptSection(contracts, agent.name),
    ]
      .filter((section) => section !== "")
      .join("\n"),
  );
}

/**
 * Every file the setup is made from, and every host.s folders: an agent
 * that could change one could give itself another agent's powers at the next
 * apply. The hook refuses any file tool that would change them.
 */
function protectList(
  input: {
    inputs: string[];
    connectionFiles: string[];
    pluginFolders: string[];
  },
  members: SetupAgent[],
) {
  // Every host's places, whichever this is: the same list for both hosts,
  // and an agent on one can't plant the other's config.
  const paths = new Set<string>([
    ...SETUP_PLACES,
    ...COPILOT_PLACES,
    ...input.inputs,
    ...input.connectionFiles,
    ...input.pluginFolders,
    ...members.flatMap((agent) => [
      ...(agent.instructions ? [agent.instructions] : []),
      ...agent.skills,
    ]),
  ]);
  return `# Written by nodrail apply. The setup's files, from the project folder:
# the policy hook keeps agents from changing them.
${[...paths].sort().join("\n")}
`;
}

/** An agent's own instructions, or a line naming it when it has none. */
export function instructionsOf(root: string, agent: SetupAgent, team: string) {
  const body = agent.instructions
    ? readFileSync(join(root, agent.instructions), "utf8")
    : `You are ${agent.name}, on team ${team}.\n`;
  return body.endsWith("\n") ? body : `${body}\n`;
}

export const byPath = (a: DesiredFile, b: DesiredFile) =>
  a.path < b.path ? -1 : 1;

/** A skill folder's files, copied as they are. Links are refused. */
function skillFiles(
  root: string,
  folder: string,
  target: string,
  problems: string[],
) {
  const files: DesiredFile[] = [];
  const name = target.split("/").pop()!;
  const walk = (relative: string) => {
    for (const entry of readdirSync(join(root, folder, relative)).sort()) {
      const inside = relative ? `${relative}/${entry}` : entry;
      const stat = lstatSync(join(root, folder, inside));
      if (stat.isSymbolicLink())
        problems.push(
          `${folder}/${inside} is a link; skills are copied without links.`,
        );
      else if (stat.isDirectory()) walk(inside);
      else if (stat.size > MAX_SKILL_BYTES)
        problems.push(`${folder}/${inside} is over 1 MB.`);
      else
        files.push({
          path: `${target}/${inside}`,
          content: readFileSync(join(root, folder, inside)),
          why: `skill ${name}`,
        });
    }
  };
  walk("");
  if (files.length > MAX_SKILL_FILES)
    problems.push(`${folder} has over ${MAX_SKILL_FILES} files.`);
  return files;
}
