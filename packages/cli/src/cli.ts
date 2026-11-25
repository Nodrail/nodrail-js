import { parseArgs } from "node:util";
import { hasLegacySetup, LEGACY_HINT } from "./setup/legacy.ts";
import {
  login,
  logout,
  noArgs,
  requireArg,
  showWhoami,
} from "./commands/auth.ts";
import {
  activity,
  insights,
  parseInsightDays,
  run,
  runs,
} from "./commands/read.ts";
import { legacyConnect, parseLegacyConnectArgs } from "./commands/connect.ts";
import {
  connectProject,
  connectionTarget,
} from "./commands/connect-project.ts";
import { connection, parseConnectionArgs } from "./commands/connection.ts";
import { connector, parseConnectorArgs } from "./commands/connector.ts";
import { budgets, checkBudgetArgs } from "./commands/budgets.ts";
import { checkEvidenceArgs, evidence } from "./commands/evidence.ts";
import { contracts } from "./commands/contracts.ts";
import { example } from "./commands/example.ts";
import { checkPolicyCommand, policy } from "./commands/policy.ts";
import { add, parseAddArgs } from "./commands/project.ts";
import { parseRulesArgs, rules } from "./commands/rules.ts";
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
  workspace: { type: "string" },
  url: { type: "string" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
  yes: { type: "boolean", short: "y" },
  agent: { type: "string" },
  runtime: { type: "string" },
  "require-active": { type: "boolean" },
  "replace-live": { type: "boolean" },
  check: { type: "boolean" },
  details: { type: "boolean" },
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

const global = ["json", "environment", "workspace", "url", "help", "version"];
const listing = ["q", "agent", "outcome", "range", "limit", "cursor"];

type Input = { args: string[]; values: Values };
type Entry = {
  run(command: Command): Promise<void>;
  options: string[];
  validate(input: Input): unknown;
};

const forwarded = new Map<
  string,
  {
    run(args: string[], io: Io): number | Promise<number>;
    validate(args: string[]): unknown;
  }
>([
  ["policy", { run: policy, validate: checkPolicyCommand }],
  ["connection", { run: connection, validate: parseConnectionArgs }],
  [
    "connector",
    {
      run: (args, io) => connector(args, io, VERSION),
      validate: parseConnectorArgs,
    },
  ],
  ["evidence", { run: evidence, validate: checkEvidenceArgs }],
  ["budgets", { run: budgets, validate: checkBudgetArgs }],
]);

function arity(min: number, max: number, usage: string) {
  return ({ args }: Input) => {
    if (args.length < min || args.length > max)
      throw new UsageError(`Usage: nodrail ${usage}`);
  };
}

const projectFolder = (verb: string) =>
  arity(
    0,
    1,
    `${verb} [<project folder>] [--runtime claude-code|codex|copilot]`,
  );

const confirmable = (verb: string) => (input: Input) => {
  projectFolder(verb)(input);
  if (input.values.json && !input.values.yes)
    throw new UsageError(
      `\`nodrail ${verb} --json\` needs --yes: it can't ask.`,
    );
};

function subcommand(
  usage: string,
  sizes: Record<string, number | readonly [number, number]>,
) {
  return ({ args: [name, ...args], values }: Input) => {
    if (!name || !Object.hasOwn(sizes, name))
      throw new UsageError(`Usage: nodrail ${usage}`);
    const size = sizes[name]!;
    const [min, max] = typeof size === "number" ? [size, size] : size;
    arity(min, max, usage)({ args, values });
  };
}

const commands: Record<string, Entry> = {
  login: { run: login, options: ["token-stdin"], validate: noArgs },
  logout: { run: logout, options: [], validate: noArgs },
  whoami: { run: showWhoami, options: [], validate: noArgs },
  activity: {
    run: activity,
    options: [...listing, "kind", "run"],
    validate: noArgs,
  },
  runs: { run: runs, options: listing, validate: noArgs },
  run: {
    run,
    options: [],
    validate: (input) => requireArg(input, "the run's ID"),
  },
  insights: {
    run: insights,
    options: ["days"],
    validate(input) {
      noArgs(input);
      parseInsightDays(input.values);
    },
  },
  rules: {
    run: rules,
    options: ["yes"],
    validate: ({ args }) => parseRulesArgs(args),
  },
  add: { run: add, options: [], validate: ({ args }) => parseAddArgs(args) },
  connect: {
    run: connectProject,
    options: ["runtime", "details"],
    validate: connectionTarget,
  },
  plan: {
    run: plan,
    options: ["runtime", "require-active", "replace-live", "details"],
    validate: projectFolder("plan"),
  },
  example: {
    run: example,
    options: [],
    validate: arity(0, 2, "example [<name> [<folder>]]"),
  },
  contracts: {
    run: contracts,
    options: [],
    validate: subcommand(
      "contracts render <agent> | validate <target> <file> | explain <binding|gate>",
      {
        render: 1,
        validate: 2,
        explain: 1,
      },
    ),
  },
  apply: {
    run: apply,
    options: ["yes", "runtime", "replace-live", "details"],
    validate: confirmable("apply"),
  },
  destroy: {
    run: destroy,
    options: ["yes", "runtime"],
    validate: confirmable("destroy"),
  },
  status: {
    run: status,
    options: ["runtime"],
    validate: projectFolder("status"),
  },
  observe: {
    run: observe,
    options: ["detach", "names"],
    validate: arity(1, 1, "observe <project folder> [--names] [--detach]"),
  },
  plugin: {
    run: plugin,
    options: ["yes", "check"],
    validate: subcommand("plugin fetch [<name>] [--check] [--yes]", {
      fetch: [0, 1],
    }),
  },
  workspace: {
    run: workspace,
    options: ["yes"],
    validate: subcommand("workspace publish [folder] | show [folder]", {
      publish: [0, 1],
      show: [0, 1],
    }),
  },
};

export const HELP = `nodrail — your Nodrail workspace from the terminal

Usage: nodrail <command> [options]

  login                  Sign in using your browser; --token-stdin for a personal token
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
  connect <url>          Connect this project, sign in if needed, then plan
  plan [folder]          What \`nodrail apply\` would set up for the team (preview)
  apply [folder]         Set up the team on its host, after showing the plan (preview)
  destroy [folder]       Remove generated setup and disconnect this machine (preview)
                         Published policy, history, connect: in nodrail.yaml and your
                         personal login stay. Use nodrail logout to end your login.
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
  --workspace <slug>     Select the workspace for a management command
  --runtime              connect, plan, apply, destroy, status: claude-code, codex or copilot
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

function parseCommand(argv: string[]) {
  const {
    values,
    positionals: [name, ...args],
  } = parse(argv);
  const entry =
    name && Object.hasOwn(commands, name) ? commands[name] : undefined;
  if (name && !entry) throw new UsageError(`Unknown command "${name}".`);
  if (name && entry) {
    checkOptions(name, entry, values);
    if (!values.help && !values.version) entry.validate({ args, values });
  }
  return { entry, name, values, args };
}

/** Check documented commands without starting a process or contacting a server. */
export function checkDocumentedCommand(argv: string[]) {
  if (argv[0] === "connect" && argv[1] === "hook") {
    parseLegacyConnectArgs(argv.slice(1));
    return;
  }
  const delegate = forwarded.get(argv[0] ?? "");
  if (delegate) {
    delegate.validate(argv.slice(1));
    return;
  }
  const { entry, values } = parseCommand(argv);
  if (!entry && !values.help && !values.version)
    throw new UsageError("Missing a nodrail command.");
}

/** Runs one command line and answers its exit code: 0, 1 error, 2 usage. */
export async function main(argv: string[], io: Io): Promise<number> {
  try {
    if (argv[0] === "connect" && argv[1] === "hook")
      return await legacyConnect(argv.slice(1), io);
    // These commands parse their own flags and may own stdin and stdout.
    const delegate = forwarded.get(argv[0] ?? "");
    if (delegate) return await delegate.run(argv.slice(1), io);
    const { entry, name, values, args } = parseCommand(argv);
    if (values.version) {
      io.out(VERSION);
      return 0;
    }
    if (values.help || !entry) {
      io.out(HELP);
      if (!entry && hasLegacySetup(io.cwd, io.home, io.env))
        io.out(LEGACY_HINT);
      return entry || values.help ? 0 : 2;
    }
    await entry.run(await commandFor(io, values as Values, args, name));
    return 0;
  } catch (error) {
    const failure = describeFailure(error);
    io.err(`nodrail: ${failure}`);

    if (error instanceof UsageError) io.err("Run `nodrail --help` for usage.");
    return exitCodeOf(error);
  }
}
