// `nodrail connector <name>`: Nodrail's own tool servers, which a
// connection starts. Each speaks MCP on stdio; stdout is the protocol, so
// every message for a person goes to stderr.
import { parseArgs } from "node:util";
import { serveMcp, type Tool } from "../connectors/mcp-stdio.ts";
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
