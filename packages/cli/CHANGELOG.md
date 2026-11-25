# Changelog

## Unreleased

- Run Windows host and connector batch launchers even when PATH omits Windows system tools.

- Verify browser sign-in launch commands for Windows, macOS and Linux on every test host.

- Confirm browser CLI sign-in without prompting for workspace creation when the selected workspace is unavailable.
- Ship the support-desk example with ignore rules for generated host files and document how to verify Claude Code at runtime.

- Run connect preflight before updating project files. Protect local credentials with Windows DPAPI or private POSIX permissions, migrate older files on read, and fence credential publication against expired writers.

- Validate connect destinations before writing, distinguish hook configuration from host-confirmed activation, and provide teammate setup and teardown instructions. Destroy can reconcile an interrupted enrollment through personal CLI sign-in.

- Report hook activation and pending policy revisions separately. Use the same machine setup totals in plan and apply.

- Recover interrupted enrollments during destroy, preserve rotated credentials, and require explicit review before connecting a project with unlocked edits. Connect preserves file permissions.

- Add `nodrail connect` for browser sign-in, configuration and planning. Summarize connected plans and link applied projects to Activity → Runs.
- Apply host-only changes such as watch mode without publishing another version of the same policy.

- Keep applied enrollment bindings outside the project and retry an incomplete disconnect without losing the credential. Group removed catalog rules in concise plans.

- Show the next policy version and its published rule counts in connected plans. Expand catalog changes with `--details`.
- Send the first Inventory observation at apply time. On destroy, revoke and remove the enrolled credential and provide server-side cleanup instructions if it could not be revoked.
- Only show the legacy migration notice for detected legacy configuration.

## 0.7.1

- Make connect, plan, and apply accept legacy hex machine IDs. Preserve valid machine ID files and show how to repair malformed files.

## 0.7.0

Uses `@nodrail/policy-engine` 0.9.0, published with it. `nodrail login` opens
the browser once; `nodrail apply` registers declared agents and enrolls this
machine, so no credential is copied by hand.

- CLI 0.7.0 supports the console’s generated project setup for Claude Code, Codex and Copilot.

- Show takeover impact, refresh stale machine enrollment and publish locked contract and evidence bindings on apply.

- Sign in with the browser, then plan and apply agents, policy and machine enrollment from a locked project.
- Generate project IDs for copied examples and show control-plane additions and removals before confirmation.

- Apply writes a private record so the Claude Code plugin can step aside for the verified project hook. Credential preflight checks the configured issuer before sending a bearer.

- Connected observations write to Inventory with the machine credential. Additional OTLP export remains optional.
- Allow Codex setup to complete while reporting hook trust and watch mode separately. Share command argument validation with the public docs checks.

- Generate host hooks and MCP connections with the running CLI's absolute Node and entry paths, including connections declared as command: nodrail.
- Require a current, enforcing hook for plan --require-active. Add Copilot to the support desk.
- Show source drift and the connected hook's last policy check in status. Name session restart and live-policy behavior after destroy.
- Document the cutover from standalone plugins and CLI 0.4/0.5. Render Insights from the server's decision counters without relying on timing fields.

## 0.6.0

Uses `@nodrail/policy-engine` 0.8.0, published with it. 0.5.0 was never
published to npm; 0.6.0 includes its changes.

- Install the connected engine hook on Claude Code, Codex and Copilot.
  `decide: cloud` publishes and pins policy for host-side decisions, evidence
  reads and reporting. `decide: local` uses repository policy.
- Support `enforce: watch` and retire `nodrail connect hook`. Reapply the setup
  to replace an installed legacy hook.

## 0.5.0

Uses `@nodrail/policy-engine` 0.7.0, published with it. `connect:` and
`plan`/`apply` connect a project to a control plane; the effective policy
is `.nodrail/effective.yaml`; the approval commands are gone.

### Removed

- `nodrail approvals`, `nodrail approve` and `nodrail reject`, with
  `NodrailApi.approvals()`, `approval()` and `decide()`: nothing waits for a
  person, so there is nothing to approve. A rule allows or denies; gates,
  budgets and evidence say when a call is allowed.

### Changed

- The connected hook's timeout in `.claude/settings.json` is 30 seconds (it
  was 360, to wait for a person); a call Nodrail hasn't answered in 25 is
  denied.
- `@nodrail/dependency-updates`: the deps agent commits and pushes its own
  branch, and is denied changing package.json, pushes that name no branch or
  name main or master, and force pushes; nothing waits for a person.
  `@nodrail/merge-reviewed-pr` says to override its merge rule with `deny`
  to keep merging for people only. The support-desk example lets support
  publish to `help-center` only.
- The README leads with `nodrail.yaml`, `plan` and `apply`.

### Added

- `nodrail policy hook --report <file>` (from `@nodrail/policy-engine`):
  the engine's hook records each decision and outcome in Nodrail through
  `POST /api/v1/runtime/decisions`, queued on disk and sent by a detached
  process, never delaying a decision. `apply` doesn't install it yet.

- `plan` reads `connect:`. It says who decides, and with a
  credential it asks Nodrail's new `GET /api/v1/runtime/identity` whose it
  is, failing when it belongs to another workspace or environment; it never
  prints it. `decide: cloud` and `enforce: watch` are checked but refused
  for now (`!`), so `apply` doesn't set up a project that would silently
  decide on this machine. `decide: local` works as before. See "Connect to
  Nodrail" in `docs/playbooks.md`.
- With `decide: cloud`, `plan` compares the policy live in the environment
  with the lock, through Nodrail's new `GET /api/v1/rules/live`. It reports
  in sync, "apply publishes" (with its preview), or drift: rules changed in
  Nodrail or by another project, refused unless `--replace-live`. `apply`
  publishes the locked policy, tagged with the project's `id` and lock,
  before it writes any file.
- `decide: cloud` works for Claude Code (connected mode PR 3). `apply`
  installs `nodrail connect hook` on every event the plugin hooks. It runs
  the local guards first (protect list, setup, run ledger, connections'
  data), then asks Nodrail with `@nodrail/client`'s hook, using the
  credential `connect:` names. `.nodrail/connect.json` holds references
  only. `apply` refuses when the live policy can't be checked. `status`
  knows the connected hook.

## 0.4.0

Uses `@nodrail/policy-engine` 0.6.0, published with it: engine levels 4
and 5 (declared contracts, evidence and numeric budgets).

### Added

- Engine level 5 (Wave 3): evidence and numeric budgets in a project.
  - With numeric budgets, `apply` registers the policy hook on
    `PostToolUse` and `PostToolUseFailure` (Claude Code), `PostToolUse`
    (Codex) and `postToolUse` (Copilot), so reservations settle. A project
    without them gets byte-identical files and settings.
  - `nodrail evidence run <name> -- <cmd>`: reads the revision before and
    after the command and the JSON it wrote to `$NODRAIL_EVIDENCE_OUT`;
    nothing written is `missing`, a revision that changed is an unknown
    subject. `evidence show` lists the events and what each gate makes of
    them. `evidence submit` sends a GitHub Actions result to Cloud with the
    job's OIDC token (exit 0 stored, 3 refused, 4 unreachable). See
    `docs/evidence.md`.
  - `nodrail budgets status` and `budgets reconcile <key>
--consumed|--released --note`: the local ledger's numbers and the
    person's word on an unknown reservation, with the engine's `/ledger`.
    See `docs/budgets.md`.
  - `plan` lists each budget's label (enforced allowance, measured usage,
    agent-reported usage), window and scope, and each evidence
    requirement's authority and producers; it fails activation for
    `across: environment` in a local setup, for runtime-observed evidence
    without the setup guard, and for a missing or revoked verifier (checked
    with Cloud when there is a token). `contracts explain` says the same for
    a gate or a budget.
  - `apply` writes `.nodrail/evidence.json` (`{ url, workspace_revision }`)
    and gives the hook `--evidence` when a gate reads evidence a verifier
    produces, and `.nodrail/contracts.json` (the compiled brief and input
    contracts) for the Cloud hook to send `params.brief`.

### Changed

- Gates now use only each agent's latest finished step, per revision with
  `subject: revision` (engine). Existing gates change too, including
  level-3 gates without contracts: a QA `pass` followed by a QA `fail` now
  closes a gate that 0.3.2 left open.

### Fixed

- Evidence can be declared with nodrail.yaml's contracts: `evidence:` sits
  next to `shapes:` and `receipts:`, and the generated `nodrail.yaml
(contracts)` entry carries it, at engine level 5 only when there is some.
  A rule file's own evidence entry is refused while nodrail.yaml declares
  contracts ("declare them once"). Projects without evidence get the same
  files as before.
- The hook keeps agents out of the run ledger, and `plan` fails activation
  for runtime-observed evidence when that guard isn't on.
- `contracts explain evidence:<name>` explains the evidence (producers,
  subject, the gates that read it and with which authority), also when it
  is declared in a rule file.
- `plan` and `evidence show` list a command gate once, by its declared id.
- `status` sees `disableAllHooks` in the project's `.claude/settings.json`,
  as `plan` does, and lists it under "Since apply", as it does a policy
  hook removed, narrowed to some tools, or edited to drop its protect list.
- A project whose policy compiles to a version 4 document could not be
  locked: the effective policy was rendered back before the joined files
  were tried, and the engine can't render version 4 yet.

- Declared receipt contracts: `shapes:` and
  `receipts:` in `nodrail.yaml`, `spec.receipt` and `spec.brief` on Agent
  resources, compiled by the engine's contracts compiler. `apply` writes
  one marked receipt section, with an example that validates against the
  contract, into each generated agent file; source files are untouched.
- `nodrail contracts render <agent>`, `validate <target> <file>` and
  `explain <binding|gate>`: offline, side-effect free.
- The lock records the contracts' digests and the resolved bindings; `policy
lock` and `plan` classify a change as breaking, disclosure (a field newly
  reported), unknown or compatible. See `docs/contracts.md`.

- Receipts are enforced: the effective policy carries the receipts the
  agents end with as one `contracts` entry (engine level 4), so the hook
  reads each agent's final message against its contract, and a gate's
  `where:` on a receipt is checked. Claude Code and Copilot both run the
  hook on a subagent's start and stop whenever the policy has gates,
  budgets or receipts (Copilot had no step hooks before: its gates never
  opened). On Codex nothing captures a receipt yet, so a gate that waits
  for one stays closed.
- `nodrail contracts validate` reads a message with the engine's own
  receipt reader, fenced or `format: header`, and says the verdict and
  findings count it reads. Each generated example is read back the same
  way before it is written. A header receipt's example writes the verdict
  word in capitals, and its section says the verdict may be in any case.

### Changed

- The CLI imports the engine's public `@nodrail/policy-engine/contracts`
  subpath; no more source aliases, and no `canonicalize` dependency.
- A contracts entry in a rule file of a project whose `nodrail.yaml`
  declares contracts is refused: declare them once, in `nodrail.yaml`.

A project that declares no contracts is locked and set up byte for byte as
before, apart from the engine level its lock records (now 4).

### Briefs and operation inputs enforced by the hook

- The effective policy's `contracts` entry now also carries each Agent's
  brief, as declared, and each connection operation's `input`, with the
  shapes they need. The hook checks a dispatch's brief before the agent
  starts and a call's arguments before any rule; rules
  and gates read them with `where` on `brief.` and `input.`. On Codex the
  dispatch prompt is encrypted, so starting an agent that has a brief is
  denied. A project that declares a brief or an input gets a new effective
  policy: lock it again.
- The object form of `spec.brief` (`format: header` with aliases) is
  rendered as `key: value` lines, and `validate brief:` and the generated
  examples use the engine's `readBrief`, the hook's own reader.
- Header findings counts: render writes a findings object as
  `findings: 0 blocker / 1 major`, `validate` says `1 finding (0 blocker /
1 major)` (`findingsLine` in `--json`), and `explain` describes it.
- `plan` lists each `where` on a brief or input field the projection
  doesn't report: Nodrail Cloud never meets it (fail-closed); `explain`
  marks it.
- `validate input:` checks arguments with the engine's `checkInput`.

### Briefs (preview)

- An Agent's `spec.brief` is written into the files of the agents that
  start it (the Team's handoffs): one marked section with the
  `nodrail-brief` block to end the dispatch prompt with, each property, and
  an example that is validated and read back before it is written. Nothing
  checks a dispatch yet: that is the engine's brief reader.
- `nodrail contracts render <agent>` prints every section of an agent's
  file; `render brief:<agent>` the brief section alone. `validate
brief:<agent>` reads a dispatch prompt's final `nodrail-brief` block, and
  `validate`/`explain` take `input:<c>.<tool>` and `output:<c>.<tool>`.
- `policy lock` and `plan` classify brief and connection-shape changes: a
  narrowed brief, input or output is breaking; a newly declared input or
  output is breaking (calls or results that passed are now refused or
  withheld); a removed one is `unknown`, to review as a policy change.

### Connectors: mediated input and result contracts (preview)

- A mediated connection checks an operation's declared `input` before the
  provider is called (a refused call never reaches it) and its declared
  `output` before the agent may use the result. An invalid or unreadable
  result is withheld with the paths that fail; the provider is called once
  and never again by Nodrail. Each call is recorded with what the provider
  did (`succeeded`, `failed`, `not-called`, `unknown`) apart from whether its
  input and result conform (`valid`, `invalid`, `unsupported`). Errors and
  records never hold a value. Works for Nodrail's own connectors and for any
  MCP server on stdio behind a proxy. See `docs/connectors.md`.
- Wired: `nodrail.yaml` accepts `connections.<c>.operations.<tool>.input`
  and `output`, locks them, and `apply` writes each mediated connection's
  compiled contracts into `.nodrail/connections.json`. `nodrail connection
run` then serves that connection mediated: Nodrail's own connectors in
  process, any other provider through the proxy, each given exactly the
  environment the connection declares. Records go to
  `.nodrail/records/<connection>/calls.jsonl`, which `destroy` keeps. A
  connection that declares neither starts as before.
- MCP tool answers keep a provider's `content` blocks, `structuredContent`
  and `outputSchema`.

## 0.3.2

Uses `@nodrail/policy-engine` 0.5.2: a git that doesn't answer in time
blocks the call instead of moving the run ledger.

### Fixed

- Run gates never opened on Claude Code: `apply` didn't register the policy
  hook on `SubagentStart` and `SubagentStop`, so no step was recorded and
  every gate with `requires:` stayed unmet (it failed closed). With gates or
  budgets in the policy, `apply` now adds both; `destroy` takes them out.
  Codex has no such events, so a gate still denies there: see
  `docs/compatibility.md`.

## 0.3.1

Uses `@nodrail/policy-engine` 0.5.1: a machine id that can't be kept no
longer turns an allowed call into a block, and a cut OTLP answer is no
longer counted as delivered.

## 0.3.0

GitHub Copilot CLI as a runtime, the reporting contract v2, observation,
`nodrail status`, `destroy`, plugins, connections and the reproducible
workspace lock. Uses `@nodrail/policy-engine` 0.5.0.

### Security

- `nodrail plan` no longer starts a connection: it read the secrets a
  cloned `nodrail.yaml` named and ran the project's code with them before
  anyone accepted anything. `plan` now shows each connection's command
  line and the secrets it gets by name, and starts nothing; `apply` starts
  each once to check its tools only after the plan is accepted, and stops
  before writing when one doesn't match.
- Every project file a connection's command line names is locked and kept
  from agents, the command included, written with or without `./` or as
  `--flag=value`. Before, only `./` arguments were.
- A connection's data (`data:`, such as a memory file) is reached only
  through the connection. Before, an agent the policy kept from
  `support-memory` could still read `memory/support.jsonl` with `Read` or
  `cat`, as verified live on Claude Code 2.1.328. The hook now denies any
  file tool on it, and any shell command naming it, whatever the rules say.

### Changed

- Reporting contract v2:
  - **Auth:** `telemetry.traces.bearer` takes a raw token and sends `Authorization: Bearer`. Before, the docs had you put `Bearer ndp_…` in `NODRAIL_TOKEN`, which then broke the CLI's own use of that variable.
  - **Honest counts:** the sender reads OTLP partial success and counts kept, refused, unknown and dropped spans apart. Before, a 200 that refused spans counted them as sent. A 4xx is final; 408, 429 and 5xx retry with the same span ids.
  - **Project id:** `id:` in nodrail.yaml is the project's stable id for reports. `workspace publish` and `workspace show` need it.
  - **More reported:** decisions carry the policy's full SHA-256, the machine and the run. A run's steps and actions are reported as `nodrail.run.event`.

### Added

- GitHub Copilot CLI as a runtime (preview): `runtimes: [copilot]` and `--runtime copilot`.
  - `apply` writes `.github/agents/<name>.agent.md`, the skills in `.github/skills`, the connections in `.github/mcp.json`, and the policy hook and session-start observer in `.github/hooks/nodrail.json`. Start the team with `copilot --agent <entry>`.
  - The hook reads Copilot's calls as the Claude Code calls they are, so the same rules and modules judge them. An `apply_patch` is judged once per file it names, and a review is a deny.
  - Copilot runs the project's hooks once you trust the folder, and `status` says whether you have. `disableAllHooks` in any settings file Copilot reads makes `plan` show `!`.
  - Plugins aren't set up for Copilot yet.
  - Verified live with Copilot CLI 1.0.114: the desk's rules allowed and denied MCP connection calls per agent.
- Nodrail's Claude Code hook judges correctly when Copilot runs it. Copilot also runs a project's `.claude/settings.json` hooks.

- Observation (preview): `apply` adds a session-start hook on each host
  that runs `nodrail observe`, which records the project's latest status
  in `~/.nodrail/observations/`: counts by default, names only with
  `observe: { names: true }`, never contents or secrets. It starts apart
  and returns at once, and never fails a session. `observe: {
sessionStart: false }` leaves the hook out. `nodrail status` shows
  whether it's on and when it last recorded (stale after 24 hours). On
  Codex the new hook runs once you trust it in `/hooks`; the policy hook
  stays trusted.
- With `telemetry:` set, each observation is also sent, one
  `nodrail.observation` span per host, through the same bounded queue as
  the decisions: counts, revisions and activation; names only with
  `observe: { names: true }`; never the project's path.
- `nodrail workspace publish` (preview) makes the lock's workspace revision
  the one your team should run in a Nodrail Cloud environment: the project
  name, digests and file paths, never contents. `nodrail workspace show`
  compares it with the lock here and each host's applied revision.
- Observations carry `nodrail.machine`, a random id made once in
  `~/.nodrail/machine-id`, never the hostname.
- `nodrail status` (preview): each host as `apply` set it up, next to what
  is there now: the revision and whether the lock moved on, whether the
  hook runs, files and settings changed since apply, and the agents,
  skills, MCP servers, plugins and hooks the host loads that nodrail
  doesn't manage, here and for the user. Read-only and offline; names
  only, never contents or secrets. Exits 1 unless every host is in step
  and enforced.
- `nodrail destroy` (preview) takes out what `apply` set up, for every
  host or the one `--runtime` names, after showing what and asking: the
  files nodrail wrote and still hold what it wrote, and its entries in
  shared settings. Your entries and edits, `nodrail.yaml`, the lock, the
  resources and connection data stay; a Codex plugin install is named for
  you to remove.
- `plan` reads an administrator's settings and marks what wouldn't load:
  on Claude Code (`managed-settings.json` and `managed-settings.d/`),
  connections denied or not allowed, the project's marketplace not
  allowed, plugins turned off, agents or skills kept to plugins, another
  agent forced (`!`); on Codex, what `requirements.toml` may turn off
  (`?`). A configuration profile it can't read is marked `?`. The hook is
  also `inactive` when managed drop-ins turn hooks off or keep them to
  plugins.
- Plugins from git (preview): `from: { git, commit, path }` on a plugin
  pins it to a full commit id; a branch or tag is refused.
  `nodrail plugin fetch` copies that commit's files into the plugin's
  folder, read from git's objects so nothing in the repository runs, and
  refuses links and submodules. The lock then shows the files for review.
  `--check` compares and exits 1 when a folder differs; `plan` marks such
  a plugin `?` with that command.
- `data:` on a connection (preview) names what it keeps: never locked, kept
  from file tools and the shell, and never removed. `plan` shows it, and
  once a connection is gone from `nodrail.yaml`, says where its data stays.
- `plan` marks a connection `?` when `npx`, `bunx` or `uvx` fetches its
  package with no exact version, so each start may run another release.

- Plugins (preview): `plugins` and `agentPlugins` in `nodrail.yaml`
  declare plugin folders in the project, their MCP servers' operations, and
  who may use them. `apply` lists them in a project marketplace and switches
  them on for Claude Code and Codex, installing nothing. Claude Code loads
  them once the folder is trusted. For Codex, `plan` names the
  `codex plugin add` the person runs. The hook reads plugin tool calls as
  either host names them, plugin files are locked in the workspace and kept
  from agents, and members given a plugin may load its skills.
- `docs/compatibility.md`: the profile the workspace was verified on live
  (macOS, Node, Claude Code, Codex), what each host proves, migration notes
  for lock format 2 and the new Team rules, and the limits.
- The workspace digest also covers the effective policy, so the same files
  compiled by another engine into another policy are another revision.
  Setup locks change once: run `nodrail policy lock`.
- The support-desk example's agents can load their `cite-sources` skill on
  Claude Code (the engine's Team rules now allow it); the example is
  relocked.
- The support-desk example names the versions it was last run with
  (`tested:`), and its README checks both hosts with
  `plan --require-active` and explains the workspace lock. The package
  check now sets the example up from the installed tarball with stand-in
  hosts: plan on both starts no connector, apply starts the packaged
  connectors once, a second apply changes nothing, and Claude Code's hook
  is `configured`.
- `apply` also stops when the lock was remade after the plan was shown.
- `plan` separates whether apply could go ahead from whether the host
  enforces the policy. `Policy hook:` and `activation` in `--json` say
  `verified` (Codex said so), `configured` (Claude Code: the hook is in
  place and no settings file turns hooks off), `inactive` or `unknown`.
  `plan --require-active` also exits with 1 unless the policy is enforced;
  the default exit and the `active` key are unchanged.
- `plan` shows the reviewed revision it sets up, and `apply` records it
  per host (`revision`, `applied` in `--json`). With both hosts in one
  folder, `plan` says when a policy change reaches the other host's open
  sessions and which `apply --runtime` brings its agents and skills up to
  date. A missing `.nodrail/setup-state.json` is named, with what to do.
- The lock records a setup's whole workspace (`lock: 2`). Besides the
  policy, it hashes each agent's instructions and every skill file, and
  gives one digest over everything the setup is made from, the same on any
  machine. `plan` adds a `workspace` check that names each changed, added or
  removed file and blocks `apply` until `nodrail policy lock` reviews it.
  `policy lock` lists those changes. A policy-only project keeps `lock: 1`,
  and an older setup lock is upgraded by locking again.
- `tested` in `nodrail.yaml` (proposed): the exact `nodrail`, Node and host
  versions a workspace was tested with. `plan` shows `✓ tested` when they
  match and `? tested: unverified here: …` when not, without blocking;
  `plan --json` marks it `"unverified": true`.
- Memory through a connection (preview): a plain `env` value starting with
  `./` reaches the connection as an absolute path in the project, and `plan`
  shows it. A memory provider such as the reference MCP memory server keeps
  each agent's scope in a project file. See "Memory" in the playbooks.
- `nodrail example [name] [folder]` (preview) copies an example project out
  of the package. `support-desk` sets up marketing and support on Claude
  Code or Codex from one file: a skill, a handbook search, an outbox to
  publish to, and a policy where marketing can't search the internal
  handbook or publish and support publishes after a person's review. Its
  README walks through both hosts, counting reads and publications, and
  swapping the handbook for a search service.
- `nodrail connector http-search` and `nodrail connector files-search`:
  two MCP search connectors with one contract (`search` over a
  collection, passages with their source), so a connection swaps one for
  the other in its command line alone. `http-search` posts to a service of
  yours with `SEARCH_TOKEN`; `files-search` searches a folder of documents
  and can count reads with `--receipts <folder>`, never recording the
  query. `nodrail connector outbox` publishes texts as files, one per
  publication: an effect to count.

- Telemetry (preview): with `telemetry` in `nodrail.yaml`, `apply` writes
  `.nodrail/telemetry.json` and both hosts' hooks send each decision to
  that OpenTelemetry receiver. `plan` checks its header secrets and says
  how sending went, or that it is degraded and why.

- Tool connections (preview): `connections` and `agentConnections` in
  `nodrail.yaml` declare MCP servers and who may use them. `apply` sets each
  up natively, in `.mcp.json` (switched on in `enabledMcpjsonServers`) or in
  Codex's `[mcp_servers]`, started by `nodrail connection run`, and the hook
  judges each call as declared, before the server gets it. Secrets are
  `fromEnv` or Keychain references: no file, argument or state holds a
  value, and a connection gets only its own. `plan` names each secret's
  receiver and whether it is set, and starts each connection once to check
  it offers the declared operations.
- `nodrail connection run <file> <name>`, which hosts run to start one.

- `nodrail plan` and `nodrail apply` take the project folder, as in
  `nodrail plan ./project`, and `--runtime claude-code|codex`, which picks
  the host when `nodrail.yaml` lists both with `runtimes: [claude-code, codex]`.
  Without it, or with a host the file doesn't list, nothing is planned.

### Changed

- Each host keeps its own entry in `.nodrail/setup-state.json`, so one folder
  can be set up for Claude Code and Codex. A file both need is owned by both,
  and stays while either uses it. A state written by 0.2.0 is read as the
  one host it names.
- `.nodrail/protected.txt` lists every host's folders, whichever host is set
  up, so an agent on one can't write the other's config either.

## 0.2.0

### Added

- `nodrail.yaml` may point at setup resources (preview): agents, a team, your
  own policies and the bindings that give a module's roles to your agents.
  `policy lock` and `export --frozen` read them, folders included; see
  [Give the roles to your agents](docs/playbooks.md#give-the-roles-to-your-agents-preview).
- `nodrail plan` (preview) shows what `nodrail apply` would set up for the
  team on Claude Code: agent files, skills, the effective policy and the
  settings that start the entry agent behind the policy hook. It only reads,
  marks with `!` anything apply would refuse (a file it didn't write, one
  edited since, a link, a missing `claude` or `nodrail`, a stale lock), and
  exits with 1 then. `--json` gives the same for scripts.
- `nodrail apply` (preview) makes that plan, after showing it and asking (or
  `--yes`). It refuses anything marked `!`, re-plans as the project's only
  writer and stops if anything changed since you saw it, and journals every
  change so that a stop partway is finished by the next `nodrail`. It
  changes and removes only the files it wrote and that still hold what it
  wrote, records them in `.nodrail/setup-state.json`, and opens Claude Code
  with `start: true`.
- `nodrail plan` and `apply` set up Codex too (`runtime: codex`): the entry
  agent in `.codex/config.toml`, the other members in `.codex/agents/`, skills
  in `.agents/skills/` and the hook in `.codex/hooks.json`, which denies when
  `nodrail` can't run. Codex runs a project's hooks only once the person
  trusts the folder and the hook; nodrail asks Codex, read-only, whether it
  does, says which step is missing, and `apply` exits with 1 until then.
- `apply` writes `.nodrail/protected.txt`, every file the setup is made from,
  and both hooks pass it with `--protect-list`, so no agent can edit the
  resources, policies, instructions or skills and apply them. On Codex the
  hook's command changed: trust it again in `/hooks` after `apply`.
- `apply` never takes a file that merely matches what it would write: only
  files it created or updated are its own, so it never removes yours.
- `.claude/settings.json` behind a link, or with `disableAllHooks` on, is a
  conflict. The Codex hook runs with `--host codex`. The write lock is
  claimed whole, so two nodrail processes can't both hold it.
- `@nodrail/read-only` 1.0.1 is the updated read-only pack.
- `apply` says what an open session picks up: a new session for changed
  agent files, skills or settings; the policy from the next tool call.
- `@nodrail/open-reviewed-pr` and `@nodrail/merge-reviewed-pr` 1.0.1 declare
  the `dev` role their gates already use, so a binding names every role it
  must map. A project locked at 1.0.0 stays there until it adds 1.0.1.

### Changed

- `nodrail policy` is `@nodrail/policy-engine` 0.4.0's. Its hook judges each
  call as the agent the host says made it, not always as `--agent`; reads
  Codex's agent calls; judges shell reads such as `cat` and `rg` as the file
  reads they are; and adds `--protect-list` and `--host codex`. See the
  engine's changelog.

## 0.1.0

First release: your Nodrail workspace from the terminal, with a personal API
token (`ndp_…`).

- `nodrail login`, `logout` and `whoami`. The token is saved in
  `~/.nodrail/cli.json`, readable only by you; `NODRAIL_TOKEN` always wins.
- `nodrail approvals` (with `--watch`), `approve <id>` and `reject <id>`, which
  show exactly what is being decided and ask before deciding unless `--yes`.
- `nodrail activity`, `runs`, `run <id>` and `insights`, with the filters of
  the Activity page.
- `nodrail rules pull` and `rules push`, which previews, shows the diff and
  publishes exactly what was previewed.
- `nodrail policy`: the policy engine's offline commands (`init`, `validate`,
  `compile`, `eval`, `test`, `check`, `exec`, `hook`, `runs`), the same as
  `nodrail-policy`, with no account.
- `nodrail add`, `nodrail policy lock` and `nodrail policy export --frozen`:
  a repository's policy as `nodrail.yaml` and `nodrail.lock.yaml`, offline.
  Lock shows the permission changes since the last committed lock; frozen
  export prints one APF file only when every file, version and value matches
  the lock. Writes are staged in your home and can't be left half done.
- A catalog shipped in the package: `@nodrail/read-only`,
  `@nodrail/open-reviewed-pr` (also `@nodrail/pr_policy.yaml`),
  `@nodrail/merge-reviewed-pr`, `@nodrail/triage-issues` and
  `@nodrail/dependency-updates`.
- `--json` on every command, `--environment`, and `NODRAIL_URL` or `--url` for
  self-hosting.
- `@nodrail/cli/api`: the typed API client the command uses.
