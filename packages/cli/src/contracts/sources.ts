// Declared contracts in a project (dialect 1; receipts, briefs, operation
// inputs and evidence enforced by the hook):
// `shapes:`, `receipts:` and `evidence:` in nodrail.yaml, `spec.receipt` and `spec.brief`
// on Agent resources. The engine's setup schema is strict and doesn't know
// these keys, so the resolver reads the files without them, and the
// contracts compiler reads them whole. Nothing else may slip past: every
// other contract key stays refused by the setup schema.
import type {
  ProjectHost,
  ProjectResolution,
  ProjectSetup,
  SetupAgent,
} from "@nodrail/policy-engine/yaml";
import { parse, parseAllDocuments, stringify } from "yaml";
import { CliError } from "../io.ts";
import {
  ACCOUNTABLE_ENGINE_LEVEL,
  compileContracts,
  CONTRACTS_ENGINE_LEVEL,
  type CompiledContracts,
} from "./engine.ts";

/** What nodrail.yaml may declare, for now: the registry, receipts and evidence. */
export const MANIFEST_KEYS = ["shapes", "receipts", "evidence"] as const;
/** What a connection's operation may declare: its arguments and its result. */
export const CONNECTION_SLOTS = ["input", "output"] as const;
/** What an Agent resource may declare. */
export const AGENT_KEYS = ["receipt", "brief"] as const;

const RESOURCE_API = "apf.nodrail.com/v1alpha1";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** What the files declared, as read before the keys were taken out. */
export type Declared = {
  /** nodrail.yaml's contract keys, or null when it has none. */
  manifest: Record<string, unknown> | null;
  /** Agent documents, by the file they are in, as written. */
  agents: Map<string, Record<string, unknown>[]>;
  /** Whether any Agent names a receipt or a brief. */
  agentContracts: boolean;
  /** The text of each file read without its contract keys, as on disk. */
  originals: Map<string, string>;
};

/** nodrail.yaml without its contract keys, or the text itself when it has none. */
function readManifest(text: string, declared: Declared) {
  let value: unknown;
  try {
    value = parse(text);
  } catch {
    return text;
  }
  if (!isRecord(value)) return text;
  const slots = connectionSlots(value.connections);
  if (!MANIFEST_KEYS.some((key) => key in value) && slots === null) return text;
  declared.manifest = Object.fromEntries(
    MANIFEST_KEYS.filter((key) => key in value).map((key) => [key, value[key]]),
  );
  // The connections whole, as the contracts compiler reads them; the setup
  // schema gets them without the contract slots it doesn't know.
  if (slots !== null) {
    declared.manifest.connections = structuredClone(value.connections);
    value.connections = slots;
  }
  for (const key of MANIFEST_KEYS) delete value[key];
  return stringify(value, { lineWidth: 0 });
}

/**
 * `connections` without each operation's `input` and `output`, or null when
 * no operation declares either. Only these two keys are taken out: any other
 * key stays for the setup schema to refuse.
 */
function connectionSlots(connections: unknown) {
  if (!isRecord(connections)) return null;
  let found = false;
  const stripped = structuredClone(connections);
  for (const spec of Object.values(stripped)) {
    if (!isRecord(spec) || !isRecord(spec.operations)) continue;
    for (const operation of Object.values(spec.operations)) {
      if (!isRecord(operation)) continue;
      for (const slot of CONNECTION_SLOTS)
        if (slot in operation) {
          delete operation[slot];
          found = true;
        }
    }
  }
  return found ? stripped : null;
}

/** A resource file without its Agents' contract keys. */
function readResources(path: string, text: string, declared: Declared) {
  if (!text.includes(RESOURCE_API)) return text;
  const documents = parseAllDocuments(text);
  if (!Array.isArray(documents) || documents.some((d) => d.errors.length > 0))
    return text;
  const values: unknown[] = documents.map((document) => document.toJS());
  const agents = values.filter(
    (value): value is Record<string, unknown> =>
      isRecord(value) && value.kind === "Agent",
  );
  if (agents.length === 0) return text;
  declared.agents.set(path, structuredClone(agents));
  let stripped = false;
  for (const agent of agents)
    if (isRecord(agent.spec))
      for (const key of AGENT_KEYS)
        if (key in agent.spec) {
          delete agent.spec[key];
          stripped = true;
        }
  if (!stripped) return text;
  declared.agentContracts = true;
  return values
    .map((value) => stringify(value, { lineWidth: 0 }))
    .join("---\n");
}

/**
 * The project's files for the resolver, without contract keys, and what was
 * declared. A file that declares none is read exactly as it is.
 */
export function contractHost(host: ProjectHost, manifest: string) {
  const declared: Declared = {
    manifest: null,
    agents: new Map(),
    agentContracts: false,
    originals: new Map(),
  };
  const read = (path: string) => {
    const text = host.read(path);
    if (text === undefined) return text;
    const without =
      path === manifest
        ? readManifest(text, declared)
        : readResources(path, text, declared);
    if (without !== text) declared.originals.set(path, text);
    return without;
  };
  return { host: { ...host, read }, declared };
}

/** The resolution with every file's text as it is on disk, for the lock. */
export function asOnDisk(
  resolution: ProjectResolution,
  declared: Declared,
): ProjectResolution {
  if (declared.originals.size === 0) return resolution;
  return {
    ...resolution,
    inputs: resolution.inputs.map((input) =>
      input.kind === "local" && declared.originals.has(input.path)
        ? { ...input, text: declared.originals.get(input.path)! }
        : input,
    ),
  };
}

/** Each set-up Agent with its document as written, in the setup's order. */
function agentDocuments(setup: ProjectSetup, declared: Declared) {
  return setup.agents.flatMap((agent) => {
    const document = (declared.agents.get(agent.file) ?? []).find(
      (each) => isRecord(each.metadata) && each.metadata.name === agent.name,
    );
    return document ? [{ agent, document }] : [];
  });
}

/** The rule files' items, in effect order, each with the file it came from. */
export function policyItems(resolution: ProjectResolution) {
  const items: unknown[] = [];
  const files: { name: string; from: number }[] = [];
  for (const source of resolution.sources) {
    let value: unknown;
    try {
      value = parse(source.text);
    } catch {
      continue;
    }
    if (!Array.isArray(value)) continue;
    files.push({ name: source.name, from: items.length });
    items.push(...(value as unknown[]));
  }
  return { items, files };
}

/** Where an issue is, for a person: the file and the place in it. */
function issuePlace(
  path: (string | number)[],
  files: { name: string; from: number }[],
  agents: SetupAgent[],
) {
  const [root, index, ...rest] = path;
  const tail = (parts: (string | number)[]) =>
    parts.length > 0 ? ` ${parts.join(".")}` : "";
  if (root === "policy" && typeof index === "number") {
    const file = files.filter((each) => each.from <= index).at(-1)!;
    return `${file.name} item ${index - file.from + 1}${tail(rest)}`;
  }
  const agent = typeof index === "number" ? agents[index] : undefined;
  if (root === "resources" && agent)
    return `Agent ${agent.name} (${agent.file})${tail(rest)}`;
  return `${String(root)}${tail(path.slice(1))}`;
}

/** The name the generated contracts entry goes by in the effective policy. */
export const CONTRACTS_SOURCE = "nodrail.yaml (contracts)";

/** An Agent's `spec.brief` as written: a shape name, or the object form's. */
const briefShape = (brief: unknown) =>
  typeof brief === "string"
    ? brief
    : isRecord(brief) && typeof brief.shape === "string"
      ? brief.shape
      : null;

/** In declaration order, as nodrail.yaml lists them, only those picked. */
const ordered = <T>(all: Record<string, unknown>, picked: Record<string, T>) =>
  Object.fromEntries(
    Object.keys(all).flatMap((key) =>
      key in picked ? [[key, picked[key]!]] : [],
    ),
  );

type HookAgent = { receipt?: string; brief?: unknown };

/**
 * What each agent carries to the hook: its receipt, named explicitly, and
 * its brief as the Agent declares it (a shape name or the object form, so
 * a header brief keeps its format and aliases).
 */
function hookAgents(
  resolution: ProjectResolution,
  declared: Declared,
  contracts: CompiledContracts,
): Record<string, HookAgent> {
  const briefs = new Map<string, unknown>();
  for (const { agent, document } of agentDocuments(resolution.setup, declared))
    if (isRecord(document.spec) && document.spec.brief !== undefined)
      briefs.set(agent.name, document.spec.brief);
  return Object.fromEntries(
    Object.entries(contracts.agents).flatMap(([name, agent]) => {
      const entry: HookAgent = {
        ...(agent.receipt === null ? {} : { receipt: agent.receipt }),
        ...(agent.brief === null ? {} : { brief: briefs.get(name) }),
      };
      return Object.keys(entry).length > 0 ? [[name, entry]] : [];
    }),
  );
}

type HookConnections = Record<
  string,
  { operations: Record<string, { input: string }> }
>;

/** Each connection operation's declared input: the slot the hook checks (S03). */
function hookConnections(manifest: Record<string, unknown>) {
  const found: HookConnections = {};
  const connections = isRecord(manifest.connections)
    ? manifest.connections
    : {};
  for (const [name, spec] of Object.entries(connections)) {
    if (!isRecord(spec) || !isRecord(spec.operations)) continue;
    for (const [operation, slots] of Object.entries(spec.operations))
      if (isRecord(slots) && typeof slots.input === "string")
        (found[name] ??= { operations: {} }).operations[operation] = {
          input: slots.input,
        };
  }
  return found;
}

/**
 * The rule-file entry that carries the project's contracts to the hook: the
 * `contracts` entry engine level 4 reads, with the shapes, receipts,
 * evidence and connection inputs as nodrail.yaml writes them, and each
 * agent's receipt and brief named explicitly. Only what the hook enforces
 * goes in: receipts an Agent ends with, briefs an Agent is started with,
 * operation inputs, the evidence nodrail.yaml declares (level 5, only when
 * there is some), and the shapes they need. A result (S04) is read where
 * the call is mediated, never by the hook. Null when none is declared, so
 * such a project gets the effective policy it always got.
 */
export function contractsSource(
  resolution: ProjectResolution,
  declared: Declared,
  contracts: CompiledContracts | null,
) {
  if (contracts === null) return null;
  const manifest = declared.manifest ?? {};
  const agents = hookAgents(resolution, declared, contracts);
  const connections = hookConnections(manifest);
  const evidence = isRecord(manifest.evidence) ? manifest.evidence : {};
  const some = (value: object) => Object.keys(value).length > 0;
  if (!some(agents) && !some(connections) && !some(evidence)) return null;
  declaredOnce(resolution);
  const level = some(evidence)
    ? ACCOUNTABLE_ENGINE_LEVEL
    : CONTRACTS_ENGINE_LEVEL;
  const entry = [
    { required_engine_version: level },
    { contracts: hookContracts(manifest, agents, connections, evidence) },
  ];
  const what = some(evidence)
    ? `each connection
# operation's input, and the evidence gates read`
    : `and each connection
# operation's input`;
  return {
    name: CONTRACTS_SOURCE,
    text: `# The contracts the hook enforces, from nodrail.yaml: the receipt each
# agent ends with, the brief it is started with, ${what}. Rules and gates read them with where.
${stringify(entry, { lineWidth: 0 })}`,
  };
}

/**
 * Contracts are declared once: a rule file's own `contracts` entry is
 * refused (`only`: just one that declares this key).
 */
function declaredOnce(resolution: ProjectResolution, only?: string) {
  const { items, files } = policyItems(resolution);
  const already = items.findIndex(
    (item) =>
      isRecord(item) &&
      "contracts" in item &&
      (only === undefined ||
        (isRecord(item.contracts) && only in item.contracts)),
  );
  if (already < 0) return;
  const file = files.filter((each) => each.from <= already).at(-1)!;
  throw new CliError(
    `${file.name} declares a contracts entry, and nodrail.yaml declares contracts too: declare them once, in nodrail.yaml.`,
  );
}

/** The shape a receipt or an evidence declaration names, or null. */
const shapeOf = (declaration: unknown) =>
  isRecord(declaration) && typeof declaration.shape === "string"
    ? declaration.shape
    : null;

/** The `contracts` entry: what the agents, connections and evidence use, and the shapes they need. */
function hookContracts(
  manifest: Record<string, unknown>,
  agents: Record<string, HookAgent>,
  connections: HookConnections,
  evidence: Record<string, unknown>,
) {
  const allShapes = (manifest.shapes ?? {}) as Record<string, unknown>;
  const allReceipts = (manifest.receipts ?? {}) as Record<string, unknown>;
  const receipts: Record<string, unknown> = {};
  const shapes: Record<string, unknown> = {};
  const need = (name: string | null) => {
    if (name === null || name in shapes || !(name in allShapes)) return;
    const shape = allShapes[name];
    shapes[name] = shape;
    if (isRecord(shape) && typeof shape.extends === "string")
      need(shape.extends);
  };
  for (const { receipt, brief } of Object.values(agents)) {
    if (receipt !== undefined) {
      receipts[receipt] = allReceipts[receipt];
      need(shapeOf(allReceipts[receipt]));
    }
    if (brief !== undefined) need(briefShape(brief));
  }
  for (const { operations } of Object.values(connections))
    for (const { input } of Object.values(operations)) need(input);
  for (const declaration of Object.values(evidence)) need(shapeOf(declaration));
  const some = (value: object) => Object.keys(value).length > 0;
  return {
    shapes: ordered(allShapes, shapes),
    ...(some(receipts) ? { receipts: ordered(allReceipts, receipts) } : {}),
    ...(some(evidence) ? { evidence } : {}),
    ...(some(agents) ? { agents } : {}),
    ...(some(connections) ? { connections } : {}),
  };
}

/**
 * The project's compiled contracts, or null when it declares none: a
 * project without contracts is planned, locked and set up exactly as before.
 * Any issue is an error.
 */
export function projectContracts(
  resolution: ProjectResolution,
  declared: Declared,
): CompiledContracts | null {
  if (declared.manifest === null && !declared.agentContracts) return null;
  // Evidence a rule file declares would otherwise read as unknown here.
  if (declared.manifest !== null) declaredOnce(resolution, "evidence");
  const { items, files } = policyItems(resolution);
  const agents = agentDocuments(resolution.setup, declared);
  const result = compileContracts({
    manifest: declared.manifest ?? {},
    resources: agents.map((each) => each.document),
    policy: items,
  });
  const named = agents.map((each) => each.agent);
  if (!result.ok)
    throw new CliError(
      [
        "The declared contracts (preview) don't compile:",
        ...result.issues.map(
          (issue) =>
            `  ${issuePlace(issue.path, files, named)}: ${issue.message} (${issue.code})`,
        ),
      ].join("\n"),
    );
  return result.contracts!;
}
