import { parseArgs } from "node:util";
import { login, logout, showWhoami } from "./commands/auth.ts";
import { activity, insights, run, runs } from "./commands/read.ts";
import { legacyConnect } from "./commands/connect.ts";
import { connection } from "./commands/connection.ts";
import { connector } from "./commands/connector.ts";
import { budgets } from "./commands/budgets.ts";
import { evidence } from "./commands/evidence.ts";
import { contracts } from "./commands/contracts.ts";
import { example } from "./commands/example.ts";
import { policy } from "./commands/policy.ts";
import { add } from "./commands/project.ts";
import { rules } from "./commands/rules.ts";
import { apply, plan } from "./commands/setup.ts";
import { destroy } from "./commands/destroy.ts";
import { status } from "./commands/status.ts";
import { observe } from "./commands/observe.ts";
import { plugin } from "./commands/plugin.ts";
import { workspace } from "./commands/workspace.ts";
import { commandFor, type Command, type Values } from "./context.ts";
import { describeFailure, exitCodeOf, UsageError, type Io } from "./io.ts";

import { VERSION } from "./version.ts";

export { VERSION };

const options = {
  json: { type: "boolean" },
  environment: { type: "string", short: "e" },
  url: { type: "string" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
  yes: { type: "boolean", short: "y" },
  agent: { type: "string" },
  runtime: { type: "string" },
  "require-active": { type: "boolean" },
  "replace-live": { type: "boolean" },
  check: { type: "boolean" },
  detach: { type: "boolean" },
  names: { type: "boolean" },
  q: { type: "string" },
  outcome: { type: "string" },
  kind: { type: "string" },
  range: { type: "string" },
  run: { type: "string" },
  limit: { type: "string" },
  cursor: { type: "string" },
  days: { type: "string" },
  "token-stdin": { type: "boolean" },
} as const;

const global = ["json", "environment", "url", "help", "version"];
const listing = ["q", "agent", "outcome", "range", "limit", "cursor"];

type Entry = { run(command: Command): Promise<void>; options: string[] };

const commands: Record<string, Entry> = {
  login: { run: login, options: ["token-stdin"] },
  logout: { run: logout, options: [] },
  whoami: { run: showWhoami, options: [] },
  activity: { run: activity, options: [...listing, "kind", "run"] },
  runs: { run: runs, options: listing },
  run: { run, options: [] },
  insights: { run: insights, options: ["days"] },
  rules: { run: rules, options: ["yes"] },
  add: { run: add, options: [] },
  plan: { run: plan, options: ["runtime", "require-active", "replace-live"] },
  example: { run: example, options: [] },
  contracts: { run: contracts, options: [] },
  apply: { run: apply, options: ["yes", "runtime", "replace-live"] },
  destroy: { run: destroy, options: ["yes", "runtime"] },
  status: { run: status, options: ["runtime"] },
  observe: { run: observe, options: ["detach", "names"] },
  plugin: { run: plugin, options: ["yes", "check"] },
  workspace: { run: workspace, options: ["yes"] },
};

export const HELP = `nodrail — your Nodrail workspace from the terminal

Usage: nodrail <command> [options]

  login                  Save a personal token (ndp_…); --token-stdin to pipe it
  logout                 Forget the saved token
  whoami                 The person, workspace, role and scopes behind the token
  activity               Events; --q --agent --outcome --kind --range --run
  runs                   Runs; --q --agent --outcome --range
  run <id>               One run and its timeline
  insights               Decision and rule numbers; --days 7|30|90
  rules pull [file]      The rules file (to stdout without a file)
  rules push <file>      Preview, show the diff, confirm and publish

Project policy (offline, no account; run where nodrail.yaml is)
  add <module | ./file>  Add a catalog module (@nodrail/…) or a rules file
  policy lock            Review the permission changes and record them
  policy export --frozen The locked policy as one rules file, or an error
  example [name] [dir]   Copy an example project, such as support-desk (preview)
  plan [folder]          What \`nodrail apply\` would set up for the team (preview)
  apply [folder]         Set up the team on its host, after showing the plan (preview)
  destroy [folder]       Take out what apply set up; keeps your files and data (preview)
  status [folder]        Each host as apply set it up, next to what is there now (preview)
  observe <folder>       Record status in ~/.nodrail; the session-start hook runs it (preview)
  plugin fetch [name]    Copy a plugin from git at its pinned commit; --check compares (preview)
  workspace publish      Make the lock here the revision your team should run (preview)
  workspace show         The team's intended revision next to the lock and each host (preview)
  contracts render <agent>      The receipt section for an agent's file (preview)
  contracts validate <t> <file> Check a sample against a contract, offline (preview)
  contracts explain <b|gate>    What a binding or gate asks for, and what satisfies it (preview)

Policies (offline, no account), the same as nodrail-policy
  policy init <pack>     A starter rules file: read-only or repo-work
  policy validate <dir>  Check rule files; also compile, eval, test --cases
  policy check|exec      <dir> -- <program>: allowed? exec also runs it
  policy hook <dir>      Claude Code hook; reads the event from stdin
  policy runs            What the local run ledger recorded
  policy --help          Every policy command and its flags
  connection run <file> <name>  Start a tool connection; hosts run this
  connector <name>       Nodrail's connectors: http-search, files-search, outbox

Evidence and budgets (engine level 5; a person runs these, never an agent)
  evidence run <name> -- <cmd>   Run a check and record what it wrote to $NODRAIL_EVIDENCE_OUT
  evidence submit <name>         From GitHub Actions: send a result to the control plane with the job's OIDC token
  evidence show <name>           Evidence recorded here, and the gates reading it
  budgets status                 Numeric budgets as the local run ledger counts them
  budgets reconcile <key>        Settle an unknown reservation: --consumed|--released --note

Options
  --json                 Machine-readable output on stdout
  -e, --environment      An environment's slug (default: the workspace's)
  --url                  Nodrail's address, for self-hosting (or NODRAIL_URL)
  --runtime              plan, apply, destroy, status: claude-code or codex
  -y, --yes              Don't ask before publishing
  --limit, --cursor      Page size (1–100) and the next page's cursor
  -h, --help, -v, --version

The token comes from NODRAIL_TOKEN when set, else from \`nodrail login\`.
Never give a token that can publish to an agent Nodrail governs.`;

function parse(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      options,
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
}

function checkOptions(name: string, entry: Entry, values: object) {
  const allowed = new Set([...global, ...entry.options]);
  for (const key of Object.keys(values))
    if (!allowed.has(key))
      throw new UsageError(`\`nodrail ${name}\` doesn't take --${key}.`);
}

/** Runs one command line and answers its exit code: 0, 1 error, 2 usage. */
export async function main(argv: string[], io: Io): Promise<number> {
  try {
    // Before parsing: policy takes nodrail-policy's flags, not these.
    if (argv[0] === "policy") return await policy(argv.slice(1), io);
    if (argv[0] === "connect") return await legacyConnect(argv.slice(1), io);
    // Started by a host: its stdio belongs to the connection.
    if (argv[0] === "connection") return await connection(argv.slice(1), io);
    if (argv[0] === "connector")
      return await connector(argv.slice(1), io, VERSION);
    // Their own flags, and `run` passes everything after -- to the command.
    if (argv[0] === "evidence") return await evidence(argv.slice(1), io);
    if (argv[0] === "budgets") return await budgets(argv.slice(1), io);
    const { values, positionals } = parse(argv);
    if (values.version) {
      io.out(VERSION);
      return 0;
    }
    const [name, ...args] = positionals;
    if (values.help || !name) {
      io.out(HELP);
      return name || values.help ? 0 : 2;
    }
    const entry = commands[name];
    if (!entry) throw new UsageError(`Unknown command "${name}".`);
    checkOptions(name, entry, values);
    await entry.run(commandFor(io, values as Values, args));
    return 0;
  } catch (error) {
    io.err(`nodrail: ${describeFailure(error)}`);
    if (error instanceof UsageError) io.err("Run `nodrail --help` for usage.");
    return exitCodeOf(error);
  }
}
