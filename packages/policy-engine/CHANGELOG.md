# Changelog

## 0.5.0

GitHub Copilot CLI as a third host, and the reporting contract v2.

### Fixed

- An invalid `nodrail.yaml` field is named, with why: "The manifest's
  fields are not valid: plugins.x.from.commit: A full commit id…". Before,
  the message didn't say which field.
- `nodrail-policy hook --connections` reads each connection's `data` and
  denies file tools and shell commands that reach it, whatever the rules
  say: agents reach a connection's data only through its operations.
- Codex couldn't load the project's own skills: it reads a skill through
  its shell, and the setup guard refused any command naming the setup's
  files, reads included. A read in a shape the hook knows exactly changes
  nothing, so the file rules now decide it. `cat`, `head`, `tail`, `nl` and
  `wc` on several files (up to 20) are judged as one read per file, so one
  secret among them still denies the command.
- Claude Code's `Skill` tool is described as `claude-code skill` on a
  `skill` resource named after the skill, and a Team's rules let each member
  load the skills its Agent lists. Before, a skill set up for an agent was
  denied when it loaded it (`no rule covers claude-code skill on Skill`).
  A project with a Team gets one allow per member and skill: run
  `nodrail policy lock` to review and record them.
- A connection with `-` in its name, such as `support-memory`, is read as
  declared on Codex, which calls it `mcp__support_memory__…`: it was denied
  as undeclared. Operations that differ only by `-` and `_` are refused,
  since Codex names them alike.

### Changed

- A connection's locked files are every project file its command line
  names (`connectionPaths`), the command included, with or without `./` or
  as `--flag=value`; a `./` folder is accepted as data, unlocked. The
  `--protect-list` docs state the shell check's limits: words as written,
  not wildcards, variables or scripts.

### Added

- GitHub Copilot CLI (preview): `hook --host copilot` reads Copilot's
  `preToolUse` calls (`bash`, `view`, `create`, `edit`, `rg`, `glob`,
  `web_fetch`, `task`, and MCP tools as `<server>-<tool>`) as the Claude
  Code calls they are, so the same rules and modules judge them, and
  answers in Copilot's shape. An `apply_patch` is judged once per file it
  names; a review is a deny. `runtimes: [copilot]` sets the team up in
  `.github/agents`, `.github/skills`, `.github/mcp.json` and
  `.github/hooks`, which are setup places agents can't change. A
  Claude Code hook that Copilot runs is detected and judged correctly.
- Reporting contract v2 (preview): every span carries `nodrail.schema=2`,
  the project's name and, with `id:` in `nodrail.yaml`, its stable
  `nodrail.project.id`. Decisions carry the policy's full SHA-256
  (`policyRevision`, the lock's `effective.sha256`), the machine
  (`machineId`) and the run; a run's steps and actions are sent as
  `nodrail.run.event` spans (`runEventSpan`, run keys hashed with
  `runRef`). `telemetry.traces.bearer` takes a secret by reference and
  sends it as `Authorization: Bearer`.
- The sender reads OTLP partial success (`deliveryOf`) and counts sent,
  refused, unknown and dropped spans apart in its status. A 4xx is final;
  408, 429, 5xx and network errors retry with the same span ids, which a
  receiver dedupes on.
- `decodeSpans` reads an OTLP/HTTP traces export, protobuf or JSON, for
  receivers.
- `id:` in a project manifest (a UUID), read into the setup as `id`.
- `@nodrail/policy-engine/compile`: `compilePolicies` without Node
  built-ins, for browsers.

- `plugins` and `agentPlugins` in a project manifest: plugin folders, their
  MCP servers' operations and who may use them. `connectionCall` reads
  `mcp__plugin_<plugin>_<server>__<tool>` (Claude Code) and, with host
  `codex`, `mcp__<server>__<tool>`; the hook takes `host`. Team rules let
  members given a plugin load its skills (`skill` prefix `<plugin>:`) and
  deny its operations to the rest. A plugin's skill keeps its `:`
  (`vercel:deploy`). `.claude-plugin` is a setup place.
- `tested` in a project manifest (proposed): exact versions for `nodrail`,
  `node`, `claude-code` and `codex`, read into the setup as `tested`.
- Telemetry (preview): `telemetry.traces` in `nodrail.yaml` (an OTLP/HTTP
  endpoint, protobuf or JSON, headers with secrets by reference), and
  `hook --telemetry <file>`, which sends each decision as a
  `nodrail.decision` span: the decision the host was told, the rule match,
  the agent, tool, operation, resource kind, host and policy revision, with
  the host's `session.id` and `gen_ai.tool.call.id`. Never arguments,
  resources, prompts or secrets. Spans wait in a bounded queue and a
  separate process sends them; a receiver that is down never delays a
  decision.

- Tool connections (preview): `nodrail.yaml` may declare `connections`, MCP
  servers by command, arguments, environment (secrets as `fromEnv` or
  `fromKeychain` references) and operations, and `agentConnections`, who
  may use which. A `./` file a connection runs is locked like a resource.
  A started Team's rules deny each member the connections and operations it
  isn't given. Names the engine uses for its own tools (`shell`, `files`…)
  are refused.
- `hook --connections <file>` reads a call to a declared connection as its
  declaration says: `mcp__handbook__search` with `collection: internal` is
  tool `handbook`, operation `search`, resource `collection` `internal`.
  An undeclared operation, or a missing resource argument, is denied.

- `nodrail.yaml` may say `runtimes: [claude-code, codex]` instead of
  `runtime`, for one file both hosts apply. `ProjectSetup.runtimes` lists the
  hosts; `runtime` is the host when there is only one. Both fields, or a host
  listed twice, is a problem.

## 0.4.0

### Added

- Setup resources (preview, `apf.nodrail.com/v1alpha1`): `nodrail.yaml` may
  say `runtime`, `team`, `resources` and `start`, and the resources declare
  `Agent`, `Team`, `Policy` and `PolicyBinding`. `resolveProject` reads them
  into `setup` and locks their files. A `PolicyBinding` renames the roles a
  module or Policy names to the team's agents, in `agent`, gate `requires` and
  `since`, budget `step_agent` and `kind: agent` resources. It refuses a name
  nobody plays, a role the policy doesn't name, two roles for one agent, and an
  agent off the team. A project without resources resolves as before.
- A started Team adds its own rules, last: each member may start only the
  members it hands off to, and no agent may change `.claude`, `.codex`,
  `.agents`, `.nodrail`, `nodrail.yaml` or `nodrail.lock.yaml`. Both are
  denies, on Claude Code and on Codex. Codex's calls on agents already
  started (wait, send input, close…) are allowed. `teamRules` and
  `SETUP_PLACES` are exported.
- The hook reads Codex's own agent calls: starting one
  (`collaborationspawn_agent`, `spawn_agent`) is `tool: codex`,
  `operation: agent` on its `agent_type`, as `claude-code` `agent` is for
  Claude Code; the other collaboration calls are `tool: codex` with their own
  operation, such as `wait_agent`. Before, Codex handoffs read as unknown
  Claude Code tools.
- A started Team's rules also deny agents running `nodrail`,
  `nodrail-policy` and `nodrail-claude-hook`, so none can lock and apply a
  setup it changed.
- `hook --protect-list <file>` protects the files a list names, as it
  protects its rule files: any file tool that would change one is denied,
  and a list that can't be read blocks.
- With `--protect-list`, the hook also denies shell commands naming a setup
  file, the list, `~/.nodrail`, or Nodrail itself by any path, whatever the
  rules allow.
- `hook --host codex` denies a call that needs a review, with the reason:
  Codex treats an `ask` answer as a failed hook and runs the call.
- A binding is refused when two names its policy uses would be one agent,
  including a role mapped onto an agent the policy already names. Role names
  like `constructor` are plain names. An agent's instructions and skills
  can't come from `.claude`, `.codex`, `.agents` or `.nodrail`.
- The hook also judges a shell command that only reads one file or searches
  a folder (`cat`, `head`, `tail`, `nl`, `wc`, `sed -n '<lines>p'`, `grep` on
  one file, `ls`, `rg`) as that file read or search, and the stricter
  decision holds. The file rules, secrets included, decide reads made through
  a shell as they decide the Read and Grep tools, and rules about commands
  keep their meaning. Paths the shell would expand, hidden-file searches and
  recursive grep stay commands. This is how Codex reads files.
- The read-only and repo-work packs allow Claude Code's task tools
  (`TaskCreate`, `TaskUpdate`, `TaskList`, `TaskGet`) and `ToolSearch`.
- `ProjectHost.list`, optional, lists a folder's `.yaml` files for
  `resources: ./folder`. `renameAgents` is exported.

### Changed

- The local hook judges each call as the agent Claude Code or Codex says made
  it: a subagent's type, or the session's `claude --agent`. `--agent` names
  the entry agent, for calls the host doesn't label. Before, every call in a
  session was judged as `--agent`. A rule for that agent no longer covers its
  subagents' calls; give them their own rules.

## 0.3.0

Project manifests, a permission diff, and a safer reading of file paths.

### Added

- `resolveProject` (`@nodrail/policy-engine/yaml`) composes a project's
  `nodrail.yaml` (`kind: nodrail.project/v1`): ordered imports of local rules
  files, nested manifests and catalog modules with typed values (`with:
{ repository: owner/name }`). A file shared by two imports is applied once.
  Cycles, paths or links that leave the project folder, unknown publishers,
  versions in the manifest and conflicting values are refused, each naming the
  reference. It reads only what its host gives it, so it runs in a browser too.
  `catalogEntry`, `canonicalId`, `parseModuleRef`, `bindingsUsed` and
  `joinPath` are exported with it.
- `permissionChanges(before, after)` and `renderPermissionChanges(changes)`
  (also from the package root): what an edit does to permissions, grouped by
  agent, operation and resource, as granted, revoked, tightened, loosened,
  changed or needs review. A change that weakens a deny, a gate or a budget is
  marked `!`. Checked against the evaluator with generated policies.
- `@nodrail/policy-engine/command-line` exports `runPolicyCommandLine(argv,
io)`: `nodrail-policy` as a function, which `nodrail policy` runs.
- File calls carry `file_name`, the file's own name, so a rule can allow files
  by name without matching folders that share it.

### Changed

- The `read-only` starter pack also denies running `nodrail`, which can
  approve requests. `repo-work` protects `nodrail.yaml`, `nodrail.lock.yaml`
  and `.nodrail` like the other control places.
- `nodrail-policy` with a rules file it can't read prints the reason and exits
  2, instead of ending with an uncaught error.
- `nodrail-policy --version` prints the engine's own version when bundled into
  another command.

### Fixed

- A link to a file that doesn't exist yet is judged by its target. Writing
  through it creates the target, which could otherwise pass a rule that
  protects that place, such as `repo-work`'s shell startup files.

## 0.2.1

Package metadata and documentation only; the engine, CLI and hook behave
as in 0.2.0.

- npm description: "Compile, test and evaluate Agent Policy Format (APF)
  rules locally. Includes the CLI, TypeScript evaluator and local Claude Code
  hook." Keywords add `apf` and `agent-policy-format`.
- The quickstart starts in an empty folder with a two-rule policy, three
  proposed commands (allow, deny, none) and three CI cases.
- Gates, budgets and the `runs` command are marked as preview and name the
  engine release that has them.

## 0.2.0

Gates, budgets and receipts. Engine level 3.

### Breaking

- Starting a Claude Code subagent (`Agent`, and `Task`, its earlier name) is
  described with the subagent's type as resource `{ kind: agent, id: <type> }`
  instead of `{ kind: tool, id: Agent }`. A rule for `tool: claude-code`,
  `operation: agent` with resource kind `tool` is now a compile error that
  points to
  [Upgrading rules for subagents](docs/runs.md#upgrading-rules-for-subagents),
  instead of quietly never matching.
- A file with gates or budgets compiles to document `version: 2`, which
  earlier engines reject. `validate` reports what the files compiled to, such
  as `OK, compiled to 150 rules, 2 gates and 1 budget.`, instead of
  `OK: N rules.` The counts are compiled entries: a command prefix rule
  compiles to two.
- The hook's run key is `NODRAIL_RUN`, else `<repo>/<branch>` (the `origin`
  remote as host/owner/name, with no credentials, or the repository folder's
  name), pinned to the Claude Code session by its first event, so switching
  branch doesn't change the run. On the default branch, a detached HEAD or
  outside git it is `session:<id>`.
- A budget that covers an action decided with no run applies its `otherwise`,
  as a gate with no history holds. `eval`, `check` and `exec` decide with no
  run, so they hold too.

Upgrading: change rules for starting a subagent to the new resource.

```yaml fragment
# Before
- rule: Start subagents
  tool: claude-code
  operation: agent
  resource: { kind: tool, match: exact, value: Agent }
  effect: allow

# After: any subagent, or match: exact, value: qa for one type
- rule: Start subagents
  tool: claude-code
  operation: agent
  resource: { kind: agent, match: any }
  effect: allow
```

### Added

- `gate` entries: an action that matches waits until named steps started and
  finished with accepted verdicts after the last work, otherwise `deny` or
  `require_approval`. A gate never allows on its own. Work is anything the
  `since` agents did, and any change by another agent than the one required:
  files written, edited, patched or deleted, and shell commands other than
  the read-only pack's look-around ones.
- `isChange(descriptor)` from the main entry says whether an action is such a
  change; action events take `change: true`. Old events without it are not
  changes.
- `budget` entries: tool calls per step or run, tokens and dollars per run,
  with a warning level.
- `simulate()` takes the run's history and reports gates, budgets and
  warnings with every decision.
- `parseReceipt()` and `receiptBlock()` in `@nodrail/policy-engine/receipts`
  read the receipt an agent ends its step with. They read only the last 16 KB
  of a message, and a block over `MAX_RECEIPT_TEXT` (8192 characters) is no
  receipt, as in Cloud.
- `legacySubagentRuleProblem()` from the main entry, the compile check above
  for a rule form.
- `renderPolicies()` keeps gates and budgets.
- `nodrail-policy hook` keeps a run ledger when the rules have gates or
  budgets: steps from `SubagentStart` and `SubagentStop`, receipts from the
  last message, every decided action. One JSON Lines file per run in the
  repository's git folder, with session pins next to it. Each decision reads,
  decides and records under a lock file; a call that waits over 5 seconds is
  blocked. A last line cut off mid-write is left out. Rules without gates or
  budgets never touch it.
- `nodrail-policy hook` denies any file tool change to the rule files and
  folders it loaded, before reading the rules.
- `nodrail-policy runs`, `runs show <run>` and `runs report`.
- `@nodrail/policy-engine/hook-runs`: `runKey()`, `receiptBlock()`,
  `MAX_RECEIPT_TEXT` and `agentName()` for hooks that report runs elsewhere,
  with no zod or YAML.
- Cases files take `run` and `step`, so gates and budgets can be tested in CI.
  `{ action: <agent>, command: <line> }` records a command; a `finished` with
  no open step records a whole step.
- A decision held by a used-up budget says so: "Budget … is at 61 of 60 tool
  calls. Over the limit, …".

### Changed

- Problems in rule files point at what is wrong: an unknown key (`efect:`)
  at that key, a bad value, also inside `requires` or `resource`, at that
  value, a duplicate at its name or `id`, an unknown list at where it is
  named, `required_engine_version` at its value, and an item appended by an
  override in the file that appended it. They were at the start of the entry,
  some at column 1. Only `line` and `column` change; an issue has just
  `file`, `line`, `column` and `message`.
- Gates and budgets only make the rules' decision stricter. An action no
  rule covers stays blocked when an unmet gate or used-up budget only asks
  for a review.
- Both starter packs allow starting a Claude Code subagent. What it then does
  is still decided call by call.
- Both starter packs deny running `nodrail-policy` and `nodrail-claude-hook`
  from the shell. `repo-work` sends writes to `.npmrc` to a person.

## 0.1.5

No changes to the engine; released with `@nodrail/client` 0.1.5. Tests now
fail if coverage drops.

## 0.1.4

Fixes from a third independent review.

- Names are compared without regard to case, even for folders that don't exist
  yet: on many disks `.CLAUDE` is `.claude`, so a deny on `.claude` now holds.
- The `.env` family is recognised whatever its form (`.env-prod`, `prod.env`),
  and key files by extension (`*.pem`, `*.key`, `*.p12`, `*.pfx`).
- More places credentials live: `/proc/*/environ`, Claude Code's and Codex's
  sign-in files, Nodrail's own credential, and `.git/config`.
- A command argument with a wildcard or different case that could name a
  secret (`'.e*'`, `.en?`, `./.ENV`) makes the command never simple.
- A search of the home folder, or above it, counts as reaching secrets.
- `repo-work`: changes to `package.json`, makefiles and similar go to a person,
  and npm, pnpm and yarn flags that swap the shell or config make a command
  never simple. Its summary says plainly that tests run code the agent wrote.
- Redaction catches Stripe, GitLab, Google and npm keys, and names such as
  `OPENAI_KEY`.
- New: `reachesSecret()` and `SECRET_PLACES` decide secret reads the way the
  starter packs do.

## 0.1.3

Fixes from a second independent review. Upgrade if you use the starter packs.

- The starter packs hold better:
  - `repo-work` allows writing only inside the folder the agent works in, and
    denies `.gitconfig`, `.husky`, `.mcp.json`, `.vscode`, `.ssh` and
    `LaunchAgents` as well as `.git`, the agents' settings and shell start-up
    files. Writing `~/.gitconfig` could make an allowed `git status` run code.
  - `read-only` denies searches whose file pattern could pick out a secret
    (`.env*`, `*env`, `{.env,x}`), and more places credentials live
    (`.envrc`, `.git-credentials`, `.pgpass`, SSH key files, `gh` tokens).
- A dot file with a suffix answers to its base: `.env.staging` contains `.env`.
- A command that names a place credentials live, such as
  `git log -p -- .env`, is never simple, so an allowed prefix doesn't cover it.
- New params for file calls: `inside_cwd`, and `reaches_secrets` for searches.
- Resolving a very deep path took quadratic time. Paths are now limited to
  4,096 characters and 256 levels, and resolved in linear time. A patch of
  more than 1,000 files can't be described, so a person reviews it.

## 0.1.2

Security fixes found by an independent review. Upgrade if you rely on the
starter packs or on redaction.

- Reading what an agent wrote now takes linear time. A crafted command of a few
  hundred kilobytes could take minutes to describe, which in Codex would let the
  tool run when the hook timed out.
- A known token joined to other text by the shell, such as `0'ghp_…'`, is now
  redacted.
- A search is judged by every path it can reach: `Glob /home/me/.ssh/*` and
  Grep's `glob` now count as searching that folder.
- The starter packs deny reading or searching more places where credentials
  live (`.env.*`, `.gnupg`, `.kube`, `.docker`, `.npmrc` and others), no longer
  allow `git diff` or `git show` with arguments, and in `repo-work` deny writing
  to `.git`, `.claude`, `.codex` and shell start-up files.
- More commands that run other code are never simple: `git clone -u`,
  `--config` and `--template`, `--compress-program`, `zip -TT`, `man -P`,
  `pkexec`.
- New: `{ field, op: contains, list }` matches any item of a list. Files that
  use it declare `required_engine_version: 2`.
- Types now work with `moduleResolution: nodenext`.

## 0.1.1

The first version published from GitHub Actions, with npm provenance: each
release can be traced to the commit and workflow that built it. No code changes.

## 0.1.0

First public version: the evaluator, YAML rule files with lists, macros and layering, command and tool rules, the `nodrail-policy` command line, and the Claude Code hook.
