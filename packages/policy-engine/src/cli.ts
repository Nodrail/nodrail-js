import { spawnSync } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { parseArgs } from "node:util";
import { parse } from "yaml";
import { z } from "zod";
import { describeArguments, describeToolCall } from "./actions.ts";
import { decideToolCall, toDescriptor, type Identity } from "./local-hook.ts";
import type { ActionDescriptor } from "./protocol.ts";
import {
  compilePolicies,
  type PolicyIssue,
  type PolicySource,
} from "./rules-file.ts";
import { starterPacks, type StarterPack, type StarterPackName } from "./packs.ts";
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
      console.error(`warning: ${show(warning)}`);
  if (result.ok)
    return { document: result.document, count: result.rules.length };
  for (const issue of result.issues) console.error(`error: ${show(issue)}`);
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

async function main(argv: string[]): Promise<number> {
  const split = argv.indexOf("--");
  const program = split === -1 ? [] : argv.slice(split + 1);
  const { values, positionals } = parseArgs({
    args: split === -1 ? argv : argv.slice(0, split),
    allowPositionals: true,
    options: {
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
    },
  });
  if (values.help) {
    console.log(usage);
    return 0;
  }
  if (values.version) {
    const manifest: unknown = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    );
    console.log((manifest as { version: string }).version);
    return 0;
  }
  const [command, ...paths] = positionals;
  if (command === "init") {
    const pack = starterPacks[paths[0] as StarterPackName] as
      StarterPack | undefined;
    if (!pack) {
      console.error(`Packs: ${Object.keys(starterPacks).join(", ")}`);
      return 2;
    }
    process.stdout.write(pack.text);
    return 0;
  }
  if (!command || !paths.length) {
    console.error(usage);
    return 2;
  }
  const compiled = await compileOrReport(paths, command === "hook");
  // A hook that cannot load its rules has to block, and 2 is what blocks.
  if (!compiled) return command === "hook" ? 2 : 1;
  const now = new Date(values.now ?? Date.now());

  switch (command) {
    case "validate":
      console.log(`OK: ${compiled.count} rules.`);
      return 0;
    case "compile":
      console.log(JSON.stringify(compiled.document, null, 2));
      return 0;
    case "eval": {
      const { tool, operation, kind, resource } = values;
      const identity = {
        agent: values.agent,
        installation: values.installation,
      };
      let call: Call | null = null;
      if (values.command) call = { command: values.command, ...identity };
      else if (tool && operation && kind && resource)
        call = {
          tool,
          operation,
          kind,
          resource,
          params: values.params
            ? (JSON.parse(values.params) as Record<string, unknown>)
            : {},
          ...identity,
        };
      if (!call) {
        console.error(usage);
        return 2;
      }
      const result = simulate({
        document: compiled.document,
        descriptor: descriptorFor(call),
        now,
      });
      console.log(JSON.stringify(result, null, 2));
      return 0;
    }
    case "test": {
      if (!values.cases) {
        console.error(usage);
        return 2;
      }
      const cases = caseFile.parse(parse(await readFile(values.cases, "utf8")));
      let failed = 0;
      for (const item of cases) {
        const { outcome, matchedRuleId } = simulate({
          document: compiled.document,
          descriptor: descriptorFor(item.call),
          now,
        });
        if (outcome === item.expect) console.log(`ok   ${item.name}`);
        else {
          failed += 1;
          console.log(
            `FAIL ${item.name}: expected ${item.expect}, got ${outcome}${matchedRuleId ? ` (${matchedRuleId})` : ""}`,
          );
        }
      }
      console.log(`${cases.length - failed} of ${cases.length} passed.`);
      return failed ? 1 : 0;
    }
    case "check":
    case "exec": {
      if (!program.length) {
        console.error(usage);
        return 2;
      }
      const { outcome, explanation } = simulate({
        document: compiled.document,
        descriptor: toDescriptor(describeArguments(program), {
          agent: values.agent,
          installation: values.installation,
        }),
        now,
      });
      if (outcome !== "allow") {
        console.error(`Blocked: ${explanation}`);
        return command === "exec" ? 126 : 1;
      }
      if (command === "check") return 0;
      const [file = "", ...args] = program;
      const run = spawnSync(file, args, { stdio: "inherit" });
      if (run.error) {
        console.error(run.error.message);
        return 127;
      }
      return run.status ?? 1;
    }
    case "hook": {
      let stdin = "";
      for await (const chunk of process.stdin) stdin += String(chunk);
      const result = decideToolCall(stdin, {
        document: compiled.document,
        now,
        unmatched: values.unmatched === "ask" ? "ask" : "deny",
        agent: values.agent,
        installation: values.installation,
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      return result.exitCode;
    }
    default:
      console.error(usage);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  },
);
