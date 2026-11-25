import { parseArgs } from "node:util";

const options = {
  tool: { type: "string" },
  operation: { type: "string" },
  kind: { type: "string" },
  resource: { type: "string" },
  params: { type: "string" },
  agent: { type: "string" },
  installation: { type: "string" },
  now: { type: "string" },
  cases: { type: "string" },
  command: { type: "string" },
  unmatched: { type: "string" },
  "protect-list": { type: "string" },
  connections: { type: "string" },
  telemetry: { type: "string" },
  report: { type: "string" },
  connect: { type: "string" },
  "legacy-connect": { type: "boolean" },
  evidence: { type: "string" },
  host: { type: "string" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
} as const;

export type Values = ReturnType<
  typeof parseArgs<{
    args: string[];
    allowPositionals: true;
    options: typeof options;
  }>
>["values"];

export function parsePolicyArgs(argv: string[]) {
  const split = argv.indexOf("--");
  return {
    ...parseArgs({
      args: split === -1 ? argv : argv.slice(0, split),
      allowPositionals: true,
      options,
    }),
    program: split === -1 ? [] : argv.slice(split + 1),
  };
}
