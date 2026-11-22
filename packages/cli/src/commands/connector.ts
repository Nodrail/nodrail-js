// `nodrail connector <name>`: Nodrail's own tool servers, which a
// connection starts. Each speaks MCP on stdio; stdout is the protocol, so
// every message for a person goes to stderr.
import { join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { parseArgs } from "node:util";
import type { CompiledContracts } from "../contracts/engine.ts";
import { serveMediatedProxy } from "../connectors/mcp-proxy.ts";
import { serveMcp, type Tool } from "../connectors/mcp-stdio.ts";
import {
  record,
  settleMediatedCall,
  withRunLock,
} from "@nodrail/policy-engine/ledger";
import { ledgerPlace, ledgerSink } from "../connectors/ledger-sink.ts";
import { mediateTools, recordsFile } from "../connectors/mediate.ts";
import { outboxTool } from "../connectors/outbox.ts";
import { filesBackend, httpBackend, searchTool } from "../connectors/search.ts";
import type { Io } from "../io.ts";

const USAGE = `Usage:
  nodrail connector http-search --endpoint <url>
      Search a service of yours over HTTP; its token comes from SEARCH_TOKEN.
  nodrail connector files-search --folder <folder> [--receipts <folder>]
      Search a folder of documents: one subfolder per collection.
  nodrail connector outbox --folder <folder>
      Publish texts as files, one per publication: an effect you can count.`;

/** The tool a connector serves, from its name and flags. */
export function connectorTools(
  args: string[],
  env: Record<string, string | undefined>,
): Tool[] {
  const [name, ...rest] = args;
  const { values } = parseArgs({
    args: rest,
    options: {
      endpoint: { type: "string" },
      folder: { type: "string" },
      receipts: { type: "string" },
    },
    strict: true,
  });
  if (name === "http-search" && values.endpoint && !values.folder) {
    if (!/^https?:\/\//.test(values.endpoint))
      throw new Error("--endpoint must be an http or https URL");
    return [searchTool(httpBackend(values.endpoint, env.SEARCH_TOKEN))];
  }
  if (name === "files-search" && values.folder && !values.endpoint)
    return [searchTool(filesBackend(values.folder, values.receipts))];
  if (
    name === "outbox" &&
    values.folder &&
    !values.endpoint &&
    !values.receipts
  )
    return [outboxTool(values.folder)];
  throw new Error(USAGE);
}

/** Where a mediated connection keeps its call records: project data, never locked. */
export const recordsFolder = (root: string, connection: string) =>
  join(root, ".nodrail", "records", connection);

/**
 * A connection whose operations declare `input` or `output`, served with
 * every call checked (mediate.ts) until the host closes stdin. Nodrail's
 * own connectors run here, their tools wrapped; any other provider is
 * started as an MCP server and proxied. Either way the provider gets
 * exactly `env`, the environment `nodrail connection run` built for it:
 * nothing else is inherited.
 */
export async function serveMediated(input: {
  connection: string;
  command: string;
  args: readonly string[];
  /** The provider's whole environment. */
  env: Record<string, string>;
  /** The project folder: the provider's working folder, and `./` paths' base. */
  root: string;
  contracts: CompiledContracts;
  version: string;
  stdin: Readable;
  stdout: Writable;
}) {
  // Each call also joins the run ledger the hooks of this folder use (R318),
  // where it settles its budget reservation under the run's lock.
  const place = ledgerPlace(input.root);
  const mediate = {
    connection: input.connection,
    contracts: input.contracts,
    record: [
      recordsFile(recordsFolder(input.root, input.connection)),
      ledgerSink({
        ledger: { record, withRunLock },
        place,
        settle: (call) =>
          place && settleMediatedCall(place.directory, place.run, call),
      }),
    ],
  };
  const name = `nodrail-${input.connection}`;
  if (input.command === "nodrail" && input.args[0] === "connector") {
    // In this process: a `./` argument is a project path, as when started.
    const args = input.args
      .slice(1)
      .map((arg) => (arg.startsWith("./") ? resolve(input.root, arg) : arg));
    await serveMcp({
      name,
      version: input.version,
      tools: mediateTools(connectorTools(args, input.env), mediate),
      stdin: input.stdin,
      stdout: input.stdout,
    });
    return;
  }
  await serveMediatedProxy({
    name,
    version: input.version,
    upstream: {
      command: input.command,
      args: input.args,
      env: input.env,
      cwd: input.root,
    },
    mediate,
    stdin: input.stdin,
    stdout: input.stdout,
  });
}

/** Runs `nodrail connector <args>` until the host closes its stdin. */
export async function connector(
  args: string[],
  io: Io,
  version: string,
): Promise<number> {
  let tools: Tool[];
  try {
    tools = connectorTools(args, io.env);
  } catch (error) {
    io.err((error as Error).message);
    return 2;
  }
  await serveMcp({
    name: `nodrail-${args[0]}`,
    version,
    tools,
    stdin: process.stdin,
    stdout: process.stdout,
  });
  return 0;
}
