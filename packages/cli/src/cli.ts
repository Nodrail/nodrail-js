import { parseArgs } from "node:util";
import { decide, listApprovals } from "./commands/approvals.ts";
import { login, logout, showWhoami } from "./commands/auth.ts";
import { activity, insights, run, runs } from "./commands/read.ts";
import { policy } from "./commands/policy.ts";
import { add } from "./commands/project.ts";
import { rules } from "./commands/rules.ts";
import { apply, plan } from "./commands/setup.ts";
import { commandFor, type Command, type Values } from "./context.ts";
import { describeFailure, exitCodeOf, UsageError, type Io } from "./io.ts";

export const VERSION = "0.2.0";

const options = {
  json: { type: "boolean" },
  environment: { type: "string", short: "e" },
  url: { type: "string" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
  yes: { type: "boolean", short: "y" },
  agent: { type: "string" },
  watch: { type: "boolean", short: "w" },
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
  approvals: { run: listApprovals, options: ["agent", "watch"] },
  approve: { run: (c) => decide(c, "allow_once"), options: ["yes"] },
  reject: { run: (c) => decide(c, "deny"), options: ["yes"] },
  activity: { run: activity, options: [...listing, "kind", "run"] },
  runs: { run: runs, options: listing },
  run: { run, options: [] },
  insights: { run: insights, options: ["days"] },
  rules: { run: rules, options: ["yes"] },
  add: { run: add, options: [] },
  plan: { run: plan, options: [] },
  apply: { run: apply, options: ["yes"] },
};

export const HELP = `nodrail — your Nodrail workspace from the terminal

Usage: nodrail <command> [options]

  login                  Save a personal token (ndp_…); --token-stdin to pipe it
  logout                 Forget the saved token
  whoami                 The person, workspace, role and scopes behind the token
  approvals              Requests waiting for a person; --agent <key>, --watch
  approve <id>           Approve a request once, after showing it and asking
  reject <id>            Reject a request, after showing it and asking
  activity               Events; --q --agent --outcome --kind --range --run
  runs                   Runs; --q --agent --outcome --range
  run <id>               One run and its timeline
  insights               Approval and rule numbers; --days 7|30|90
  rules pull [file]      The rules file (to stdout without a file)
  rules push <file>      Preview, show the diff, confirm and publish

Project policy (offline, no account; run where nodrail.yaml is)
  add <module | ./file>  Add a catalog module (@nodrail/…) or a rules file
  policy lock            Review the permission changes and record them
  policy export --frozen The locked policy as one APF file, or an error
  plan                   What \`nodrail apply\` would set up for the team (preview)
  apply                  Set up the team on its host, after showing the plan (preview)

Policies (offline, no account), the same as nodrail-policy
  policy init <pack>     A starter rules file: read-only or repo-work
  policy validate <dir>  Check rule files; also compile, eval, test --cases
  policy check|exec      <dir> -- <program>: allowed? exec also runs it
  policy hook <dir>      Claude Code hook; reads the event from stdin
  policy runs            What the local run ledger recorded
  policy --help          Every policy command and its flags

Options
  --json                 Machine-readable output on stdout
  -e, --environment      An environment's slug (default: the workspace's)
  --url                  Nodrail's address, for self-hosting (or NODRAIL_URL)
  -y, --yes              Don't ask before deciding or publishing
  --limit, --cursor      Page size (1–100) and the next page's cursor
  -h, --help, -v, --version

<id> is the UUID that \`nodrail approvals\` lists, not the APR- reference.
The token comes from NODRAIL_TOKEN when set, else from \`nodrail login\`.
Never give a token that can decide or publish to an agent Nodrail governs.`;

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
