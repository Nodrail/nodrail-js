import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { parsePolicyArgs, type Values } from "./policy-cli-args.ts";
import { parse } from "yaml";
import { version } from "../package.json";
import { z } from "zod";
import { describeArguments, describeToolCall } from "./actions.ts";
import { toDescriptor, type Identity } from "./local-hook.ts";
import { hookCommand } from "./hook-command.ts";
import { guardHook, hookFailure } from "./hook-guard.ts";
import { sendDecisionQueue } from "./decision-sender.ts";
import { sendSpool } from "./telemetry.ts";

// Node-only helpers the nodrail command uses for a setup.
export { hasSecret, secretName, secretValue } from "./secret-refs.ts";
// The spool and its sender, for `nodrail observe` too.
export * from "./telemetry.ts";
// Decision reporting to the control plane, for `nodrail` to install.
export { decisionSink, type DecisionSink } from "./decision-report.ts";
export { reportFile } from "./decision-destination.ts";
export { readHookConnection } from "./hook-connection.ts";
export { hookCredential, controlPlaneOrigin } from "./hook-credential.ts";
export { sendDecisionQueue } from "./decision-sender.ts";
export type { SpanRecord } from "./otlp.ts";
export { machineId } from "./reporting-spans.ts";
import { caseRun, toRunContext } from "./case-runs.ts";
import { checkRunsArgs, runsCommand } from "./runs-cli.ts";
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
  hook                 Host policy hook; reads the event from stdin
    --unmatched deny|allow When no rule covers a call (default deny)
    --protect-list <file>  Also keep the files it lists from being changed
    --connections <file>   Read calls to the setup's tool connections as declared
    --telemetry <file>     Send each decision as an OpenTelemetry span
    --connect <file>       Read policy source, enforcement and lock pins from
                           the setup (as .nodrail/connect.json)
    --report <file>        Check shared budgets and report decisions in Nodrail ({ url,
                           credential }, as .nodrail/connect.json has them)
    --evidence <file>      Ask Cloud about externally verified evidence ({ url,
                           workspace_revision }; the token is NODRAIL_TOKEN)
    --host codex|copilot   Name the host; Copilot's calls are read as the
                           Claude Code calls they are
    With gates or budgets, also SubagentStart, SubagentStop, PostToolUse and
    PostToolUseFailure (they settle numeric budgets), and the run
    is recorded in the repository's git folder.
  runs [list | show <run> | report]   What the run ledger recorded

Files are loaded in the order given; a folder loads its .yaml files by name.
Enforcing hooks block anything other than an allow. Nothing here issues a permit.`;

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
  policyDigest: string | null;
} | null> {
  const sources = await loadSources(paths);
  const result = compilePolicies(sources);
  if (!quietWarnings)
    for (const warning of result.warnings)
      io.error(`warning: ${show(warning)}`);
  if (result.ok)
    return {
      document: result.document,
      count: result.rules.length,
      policyDigest:
        paths.length === 1 && sources[0]?.name === paths[0]
          ? createHash("sha256").update(sources[0]!.text).digest("hex")
          : null,
    };
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
    expect: z.enum(["allow", "deny", "none"]),
    // A run's history, so a gate or budget can be tested like a rule.
    ...caseRun,
  }),
);

/** Where the command line reads and writes, so tests can run it in-process. */
export type Io = {
  log: (text: string) => void;
  error: (text: string) => void;
  write: (text: string) => void;
  writeError: (text: string) => void;
  readStdin: () => Promise<string>;
  env?: Record<string, string | undefined>;
  home?: string;
  fetch?: typeof fetch;
  /** How to run this command line again, as `nodrail policy` or alone. */
  self?: readonly string[];
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
  self: [process.argv[1] ?? ""],
};

let io: Io = processIo;

/** One command, with the rules it was given already compiled. */
type Run = {
  command: string;
  values: Values;
  /** What follows --: the program for check and exec. */
  program: string[];
  document: PolicyDocument;
  count: number;
  now: Date;
  /** The rule files and folders given, which the hook keeps from being changed. */
  paths: string[];
};

const identityOf = (values: Values) => ({
  agent: values.agent,
  installation: values.installation,
});

function evalCall(values: Values) {
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
  if (!call) throw new Error(usage);
  return descriptorFor(call);
}

function evalCommand({ values, document, now }: Run) {
  const result = simulate({ document, descriptor: evalCall(values), now });
  io.log(JSON.stringify(result, null, 2));
  return 0;
}

async function testCommand({ values, document, now }: Run) {
  const cases = caseFile.parse(parse(await readFile(values.cases!, "utf8")));
  let failed = 0;
  for (const item of cases) {
    const { outcome, matchedRuleId } = simulate({
      document,
      descriptor: descriptorFor(item.call),
      now,
      run: toRunContext(item.run, item.step),
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

const counted = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * What a valid file compiles to. Counts are of compiled entries, the ones the
 * limits apply to: a command rule or gate can compile to more than one.
 */
function summary(count: number, document: PolicyDocument) {
  const parts = [counted(count, "rule")];
  if (document.version !== 1)
    parts.push(
      counted(document.gates.length, "gate"),
      counted(document.budgets.length, "budget"),
    );
  const last = parts.pop();
  return parts.length ? `${parts.join(", ")} and ${last}` : last;
}

// A Map, so a command named like an Object property finds nothing.
const commands = new Map<string, (run: Run) => number | Promise<number>>([
  [
    "validate",
    ({ count, document }) => (
      io.log(`OK, compiled to ${summary(count, document)}.`),
      0
    ),
  ],
  ["compile", ({ document }) => (io.log(JSON.stringify(document, null, 2)), 0)],
  ["eval", evalCommand],
  ["test", testCommand],
  ["check", gateCommand],
  ["exec", gateCommand],
]);

function printPack(name: string | undefined) {
  const pack = starterPacks[name as StarterPackName] as StarterPack | undefined;
  if (!pack) {
    io.error(`Packs: ${Object.keys(starterPacks).join(", ")}`);
    return 2;
  }
  io.write(pack.text);
  return 0;
}

function checkPolicyOperands(
  command: string,
  paths: string[],
  values: Values,
  program: string[],
) {
  if (command === "init") {
    if (!Object.hasOwn(starterPacks, paths[0] ?? "") || paths.length !== 1)
      throw new Error(`Packs: ${Object.keys(starterPacks).join(", ")}`);
    return;
  }
  if (command === "runs") {
    checkRunsArgs(paths);
    return;
  }
  if (command === "hook") return;
  if (!commands.has(command) || !paths.length) throw new Error(usage);
  if (command === "test" && !values.cases) throw new Error(usage);
  if (command === "eval") evalCall(values);
  if ((command === "check" || command === "exec") && !program.length)
    throw new Error(usage);
}

export function checkPolicyArgs(argv: string[]) {
  const {
    values,
    positionals: [command = "", ...paths],
    program,
  } = parsePolicyArgs(argv);
  if (!values.help && !values.version)
    checkPolicyOperands(command, paths, values, program);
  return { values, command, paths, program };
}

/** Runs one nodrail-policy command and returns its exit code. */
export async function runCli(
  argv: string[],
  output: Io = processIo,
): Promise<number> {
  io = output;
  const { values, command, paths, program } = checkPolicyArgs(argv);
  if (values.help) return (io.log(usage), 0);
  if (values.version) return (io.log(version), 0);
  if (command === "init") return printPack(paths[0]);
  if (command === "runs") return runsCommand(paths, io);
  if (command === "hook") {
    const base = { values, now: new Date(values.now ?? Date.now()), paths };
    return hookCommand(base, io, async () =>
      paths.length ? await compileOrReport(paths, true) : null,
    );
  }
  const handler = commands.get(command)!;
  const compiled = await compileOrReport(paths);
  if (!compiled) return 1;
  return handler({
    command,
    values,
    program,
    document: compiled.document,
    count: compiled.count,
    now: new Date(values.now ?? Date.now()),
    paths,
  });
}

/**
 * The whole nodrail-policy command line: runs one command and answers its exit
 * code, reporting what the command did not handle (a missing file, a bad
 * flag) as one line on stderr and 2. `nodrail policy` runs this too.
 */
export async function runPolicyCommandLine(
  argv: string[],
  output: Io = processIo,
): Promise<number> {
  try {
    // The hook's sender, run detached: not a command for people.
    if (argv[0] === "telemetry-send" && argv[1] && argv[2])
      return (await sendSpool(argv[1], argv[2], process.env), 0);
    if (argv[0] === "decisions-send" && argv[1] && argv[2])
      return (await sendDecisionQueue(argv[1], argv[2], process.env), 0);
    // The hook never fails open: see hook-guard.ts.
    if (argv[0] === "hook")
      return await guardHook(
        () => runCli(argv, output),
        (text) => output.writeError(text),
      );
    return await runCli(argv, output);
  } catch (error) {
    output.error(error instanceof Error ? error.message : String(error));
    return argv[0] === "hook" ? hookFailure() : 2;
  }
}

export {
  readHostCredential,
  removeHostCredential,
  writeHostCredential,
} from "./host-credentials.ts";

export { canonicalOrigin } from "./control-plane-origin.ts";
export { evidencePins } from "./evidence-pins.ts";
export { recordAppliedHook, removeAppliedHook } from "./applied-hook.ts";
export { POLICY_CHECK_FILE } from "./hook-policy-status.ts";

export { acquireLocalLock, LocalLockBusy, processAlive } from "./local-lock.ts";
export {
  readSecretFile,
  removeSecretFile,
  writeSecretFile,
} from "./secret-store.ts";
