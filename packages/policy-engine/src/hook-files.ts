import { readFileSync } from "node:fs";
import { hookCallsFile, type ConnectionCalls } from "./connections.ts";

/** The connections file `nodrail apply` writes, as the hook reads it. */
export function readConnections(file: string): ConnectionCalls {
  const parsed = hookCallsFile.safeParse(
    JSON.parse(readFileSync(file, "utf8")),
  );
  if (!parsed.success) throw new Error(`${file} isn't a connections file`);
  // Server names are unique among both, as nodrail.yaml is checked.
  return { ...parsed.data.connections, ...parsed.data.plugins };
}
