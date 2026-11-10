import { spawnSync } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { parseArgs } from "node:util";
import { parse } from "yaml";
import { z } from "zod";
import { describeArguments, describeToolCall } from "./actions.ts";
import { decideToolCall, toDescriptor, type Identity } from "./local-hook.ts";
import type { ActionDescriptor } from "./protocol.ts";
import { compilePolicies } from "./compile.ts";
import { type PolicyIssue, type PolicySource } from "./rules-file.ts";
import {
  starterPacks,
  type StarterPack,
  type StarterPackName,
} from "./packs.ts";
import { simulate } from "./simulator.ts";
import type { Descriptor } from "./evaluator.ts";
import type { PolicyDocument } from "./policies.ts";

const usage = `Usage: nodrail-policy <command> <rules file or folder>...

Commands:
  init <pack>          Print a starter rules file: read-only or repo-work
  validate             Check rule files and report every problem
  compile              Print the compiled policy document as JSON
  eval                 Evaluate one call against the rules
    --command '<line>', or --tool --operation --kind --resource
    --params '<json>'  --agent <key>  --installation <name>  --now <iso time>
  test --cases <file>  Check expected outcomes, for use in CI
  check -- <program> [args]  Exit 0 only if the rules allow this command
  exec -- <program> [args]   Run it only if the rules allow it
  hook                 Claude Code PreToolUse hook; reads the event from stdin
    --unmatched deny|ask   When no rule covers a call (default deny)

Files are loaded in the order given; a folder loads its .yaml files by name.
Anything other than an allow is blocked. Nothing here issues a permit.`;

const yamlFile = (name: string) => [".yaml", ".yml"].includes(extname(name));

async function loadSources(paths: string[]): Promise<PolicySource[]> {
  const files: string[] = [];
  for (const path of paths)
    if ((await stat(path)).isDirectory())
      files.push(
        ...(await readdir(path))
          .filter(yamlFile)
          .sort()
          .map((name) => join(path, name)),
      );
    else files.push(path);
  return Promise.all(
    files.map(async (name) => ({ name, text: await readFile(name, "utf8") })),
  );
}

const show = ({ file, line, column, message }: PolicyIssue) =>
  `${file}:${line}:${column}: ${message}`;

async function compileOrReport(
  paths: string[],
  quietWarnings = false,
): Promise<{
  document: PolicyDocument;
  count: number;
} | null> {
  const result = compilePolicies(await loadSources(paths));
  if (!quietWarnings)
    for (const warning of result.warnings)
      io.error(`warning: ${show(warning)}`);
  if (result.ok)
    return { document: result.document, count: result.rules.length };
  for (const issue of result.issues) io.error(`error: ${show(issue)}`);
  return null;
}

type ResourceCall = {
  tool: string;
  operation: string;
  kind: string;
  resource: string;
  params?: Record<string, unknown>;
};
type Call = (ResourceCall | { command: string }) & Identity;

function descriptorFor(call: Call): Descriptor {
  if ("command" in call) {
    const action = describeToolCall("Bash", { command: call.command });
    if (!action) throw new Error("That command cannot be described.");
    return toDescriptor(action, call);
  }
  return toDescriptor(
    {
      tool: call.tool,
      operation: call.operation,
      resource: { kind: call.kind, id: call.resource },
      params: (call.params ?? {}) as ActionDescriptor["params"],
    },
    call,
  );
}

const caseFile = z.array(
  z.strictObject({
    name: z.string(),
    call: z.union([
      z.strictObject({
        command: z.string(),
        agent: z.string().optional(),
        installation: z.string().optional(),
      }),
      z.strictObject({
        tool: z.string(),
        operation: z.string(),
        kind: z.string(),
        resource: z.string(),
        params: z.record(z.string(), z.unknown()).optional(),
        agent: z.string().optional(),
        installation: z.string().optional(),
      }),
    ]),
    expect: z.enum(["allow", "deny", "require_approval", "none"]),
  }),
);

/** Where the command line reads and writes, so tests can run it in-process. */
export type Io = {
  log: (text: string) => void;
  error: (text: string) => void;
  write: (text: string) => void;
  writeError: (text: string) => void;
  readStdin: () => Promise<string>;
};

export const processIo: Io = {
  log: (text) => console.log(text),
  error: (text) => console.error(text),
  write: (text) => void process.stdout.write(text),
  writeError: (text) => void process.stderr.write(text),
  readStdin: async () => {
    let stdin = "";
    for await (const chunk of process.stdin) stdin += String(chunk);
    return stdin;
  },
};

let io: Io = processIo;

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
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
} as const;

type Values = ReturnType<
  typeof parseArgs<{
    args: string[];
    allowPositionals: true;
    options: typeof options;
  }>
>["values"];

/** One command, with the rules it was given already compiled. */
type Run = {
  command: string;
  values: Values;
  /** What follows --: the program for check and exec. */
  program: string[];
  document: PolicyDocument;
  count: number;
  now: Date;
};

const identityOf = (values: Values) => ({
  agent: values.agent,
  installation: values.installation,
});

function evalCommand({ values, document, now }: Run) {
  const { tool, operation, kind, resource } = values;
  let call: Call | null = null;
  if (values.command) call = { command: values.command, ...identityOf(values) };
  else if (tool && operation && kind && resource)
    call = {
      tool,
      operation,
      kind,
      resource,
      params: values.params
        ? (JSON.parse(values.params) as Record<string, unknown>)
        : {},
      ...identityOf(values),
    };
  if (!call) {
    io.error(usage);
    return 2;
  }
  const result = simulate({ document, descriptor: descriptorFor(call), now });
  io.log(JSON.stringify(result, null, 2));
  return 0;
}

async function testCommand({ values, document, now }: Run) {
  if (!values.cases) {
    io.error(usage);
    return 2;
  }
  const cases = caseFile.parse(parse(await readFile(values.cases, "utf8")));
  let failed = 0;
  for (const item of cases) {
    const { outcome, matchedRuleId } = simulate({
      document,
      descriptor: descriptorFor(item.call),
      now,
    });
    if (outcome === item.expect) io.log(`ok   ${item.name}`);
    else {
      failed += 1;
      const rule = matchedRuleId ? ` (${matchedRuleId})` : "";
      io.log(
        `FAIL ${item.name}: expected ${item.expect}, got ${outcome}${rule}`,
      );
    }
  }
  io.log(`${cases.length - failed} of ${cases.length} passed.`);
  return failed ? 1 : 0;
}

/** check and exec: only an allow lets the program run. */
function gateCommand({ command, values, program, document, now }: Run) {
  if (!program.length) {
    io.error(usage);
    return 2;
  }
  const { outcome, explanation } = simulate({
    document,
    descriptor: toDescriptor(describeArguments(program), identityOf(values)),
    now,
  });
  if (outcome !== "allow") {
    io.error(`Blocked: ${explanation}`);
    return command === "exec" ? 126 : 1;
  }
  if (command === "check") return 0;
  const [file = "", ...args] = program;
  const run = spawnSync(file, args, { stdio: "inherit" });
  if (run.error) {
    io.error(run.error.message);
    return 127;
  }
  return run.status ?? 1;
}

async function hookCommand({ values, document, now }: Run) {
  const result = decideToolCall(await io.readStdin(), {
    document,
    now,
    unmatched: values.unmatched === "ask" ? "ask" : "deny",
    ...identityOf(values),
  });
  if (result.stdout) io.write(result.stdout);
  if (result.stderr) io.writeError(result.stderr);
  return result.exitCode;
}

// A Map, so a command named like an Object property finds nothing.
const commands = new Map<string, (run: Run) => number | Promise<number>>([
  ["validate", ({ count }) => (io.log(`OK: ${count} rules.`), 0)],
  ["compile", ({ document }) => (io.log(JSON.stringify(document, null, 2)), 0)],
  ["eval", evalCommand],
  ["test", testCommand],
  ["check", gateCommand],
  ["exec", gateCommand],
  ["hook", hookCommand],
]);

async function printVersion() {
  const manifest: unknown = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  io.log((manifest as { version: string }).version);
  return 0;
}

function printPack(name: string | undefined) {
  const pack = starterPacks[name as StarterPackName] as StarterPack | undefined;
  if (!pack) {
    io.error(`Packs: ${Object.keys(starterPacks).join(", ")}`);
    return 2;
  }
  io.write(pack.text);
  return 0;
}

/** Runs one nodrail-policy command and returns its exit code. */
export async function runCli(
  argv: string[],
  output: Io = processIo,
): Promise<number> {
  io = output;
  const split = argv.indexOf("--");
  const { values, positionals } = parseArgs({
    args: split === -1 ? argv : argv.slice(0, split),
    allowPositionals: true,
    options,
  });
  if (values.help) return (io.log(usage), 0);
  if (values.version) return printVersion();
  const [command = "", ...paths] = positionals;
  if (command === "init") return printPack(paths[0]);
  const handler = commands.get(command);
  if (!handler || !paths.length) {
    io.error(usage);
    return 2;
  }
  const compiled = await compileOrReport(paths, command === "hook");
  // A hook that cannot load its rules has to block, and 2 is what blocks.
  if (!compiled) return command === "hook" ? 2 : 1;
  return handler({
    command,
    values,
    program: split === -1 ? [] : argv.slice(split + 1),
    document: compiled.document,
    count: compiled.count,
    now: new Date(values.now ?? Date.now()),
  });
}
