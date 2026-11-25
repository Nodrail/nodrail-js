// The Cloud hook's declared contracts: `nodrail apply` writes the
// compiled brief and input contracts to `.nodrail/contracts.json`, as it
// writes `connections.json`, and the hook sends what Cloud's rules read
// from them: the started agent's brief as its reporting projection in
// `params.brief`, an operation's input with classified fields as
// `[classified]`. The checking is the SDK's (`withContractFields`), loaded
// from its own file only for a call a contract covers, so the hook that
// runs on every call stays small and carries no schema or YAML library.
// Without the file nothing changes, and Cloud keeps a `where` on a brief
// closed. A contract that covers the call but can't be checked here blocks
// it: an unchecked brief must not reach Cloud as if it were valid.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type {
  CallContracts,
  ContractFields,
  withContractFields,
} from "./contract-fields.ts";
import type { ActionDescriptor } from "./protocol.ts";
import type { Environment } from "./connection.ts";

/** Where `nodrail apply` writes the contracts, from the project folder. */
export const CONTRACTS_FILE = ".nodrail/contracts.json";

/** Larger than any compiled closure; a bigger file isn't apply's. */
const MAX_BYTES = 1024 * 1024;

/** How far up from the session's folder the project folder may be. */
const MAX_DEPTH = 32;

type Chunk = { withContractFields: typeof withContractFields };

/** The SDK's checker: its own bundle next to the hook, or the source in tests. */
export const loadChecker = (): Promise<Chunk> => {
  const specifier = import.meta.url.endsWith(".ts")
    ? "./contract-fields.ts"
    : "./nodrail-hook-contracts.mjs";
  return import(specifier) as Promise<Chunk>;
};

/** The contracts file: the host's project folder, else the nearest above `cwd`. */
export const findContractsFile = (cwd: string, env: Environment) =>
  findProjectFile(cwd, env, CONTRACTS_FILE);

export function findProjectFile(cwd: string, env: Environment, name: string) {
  const project = env.CLAUDE_PROJECT_DIR?.trim();
  if (project) {
    const file = join(resolve(project), name);
    return existsSync(file) ? file : null;
  }
  let folder = resolve(cwd);
  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    const file = join(folder, name);
    if (existsSync(file)) return file;
    const parent = dirname(folder);
    if (parent === folder) return null;
    folder = parent;
  }
  return null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The file's contracts, or why it can't be read. */
function readContracts(file: string): CallContracts | string {
  let raw: unknown;
  try {
    const text = readFileSync(file, "utf8");
    if (Buffer.byteLength(text) > MAX_BYTES) return "it is too large";
    raw = JSON.parse(text);
  } catch (error) {
    return (error as Error).message;
  }
  if (!isRecord(raw) || raw.version !== 1) return "it isn't version 1";
  const { briefs, inputs } = raw;
  if (
    (briefs !== undefined && !isRecord(briefs)) ||
    (inputs !== undefined && !isRecord(inputs))
  )
    return "its briefs or inputs aren't objects";
  return {
    ...(briefs ? { briefs: briefs as CallContracts["briefs"] } : {}),
    ...(inputs ? { inputs: inputs as CallContracts["inputs"] } : {}),
  };
}

/** Whether a contract in the file covers this call: a brief or an input. */
function covers(contracts: CallContracts, action: ActionDescriptor) {
  const starts =
    (action.tool === "claude-code" || action.tool === "codex") &&
    action.operation === "agent" &&
    action.resource.kind === "agent";
  if (starts && Object.hasOwn(contracts.briefs ?? {}, action.resource.id))
    return true;
  return Object.hasOwn(
    contracts.inputs ?? {},
    `${action.tool}.${action.operation}`,
  );
}

const refused = (why: string): ContractFields => ({
  refusal: `Nodrail: ${why}, so this action is blocked.`,
});

/**
 * The action as Cloud should see it, or why it is refused before Cloud is
 * asked. Unchanged when no contracts file is there or none covers the call.
 */
export async function hookContractFields(
  action: ActionDescriptor,
  input: Record<string, unknown>,
  where: { cwd: string; env: Environment },
  load: () => Promise<Chunk> = loadChecker,
): Promise<ContractFields> {
  const file = findContractsFile(where.cwd, where.env);
  if (!file) return { action };
  const contracts = readContracts(file);
  if (typeof contracts === "string")
    return refused(
      `${CONTRACTS_FILE} can't be read (${contracts}); run nodrail apply`,
    );
  if (!covers(contracts, action)) return { action };
  let checker: Chunk;
  try {
    checker = await load();
  } catch {
    return refused(
      "this call has a declared contract and the hook couldn't load its checker",
    );
  }
  return checker.withContractFields(action, input, contracts);
}
