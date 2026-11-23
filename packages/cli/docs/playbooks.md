# Playbooks

> **Preview.** Playbooks need `@nodrail/cli` 0.1.0 or later. Modules with gates need engine feature level 3: see [Runs, gates and budgets (preview)](../../policy-engine/docs/runs.md).

A playbook is a policy for one way of working, packaged so a repository can add it by name: "a publisher agent may open a draft pull request once QA and review passed", or "a triage agent may label issues and nothing else". You add it with `nodrail`, give it your values, review what it permits, and commit the result. Your agents follow it once you activate an export of it.

Everything on this page works offline, with no account. It needs the [`nodrail` command line](cli.md).

```sh
npm i -g @nodrail/cli
```

## Projects, modules and the lock

A repository's policy is described by two files at its root. Commit both.

- **`nodrail.yaml`**, the manifest. It lists what the policy is made of, in order, under `imports`. An import is a catalog module, such as `@nodrail/open-reviewed-pr`, with its values under `with:`, or a `.yaml` file in your repository. A local file is either an ordinary rules file or another manifest with its own `imports`.
- **`nodrail.lock.yaml`**, the lock. `nodrail` writes it. It records the exact version of each catalog module, the SHA-256 of every file, the values each module was given, the import graph and order, the digest of the effective policy, and the effective policy last reviewed.

A **module** is a set of rules files with a name and a version, plus the values it needs, such as your repository. The catalog of modules ships inside `@nodrail/cli`, so adding one downloads nothing.

```yaml
kind: nodrail.project/v1
imports:
  - ref: "@nodrail/open-reviewed-pr"
    with:
      repository: acme/widgets
  - ref: ./policies/team.yaml
```

The **effective policy** is every imported file compiled together, in order, into one rules file. That file is what an agent's hook or adapter reads.

## Quickstart

This adds `@nodrail/open-reviewed-pr` to a repository. Run each command at the repository's root.

**1. Add the module.**

```sh
nodrail add @nodrail/open-reviewed-pr
```

```text
Added @nodrail/open-reviewed-pr@1.0.1
Changed: nodrail.yaml, nodrail.lock.yaml
  @nodrail/open-reviewed-pr: configuration required. Set with.repository in nodrail.yaml.
Permissions: pending until every module has its values.
```

The module is in `nodrail.yaml` but not in effect: it needs a value. `add` lists its rules below this, so you can read them first.

**2. Give it your repository.** In `nodrail.yaml`, set the value as `owner/name`:

```yaml
with:
  repository: acme/widgets
```

**3. Lock and review.**

```sh
nodrail policy lock
```

```text
Updated nodrail.lock.yaml
Permissions:
  3 permission changes.

  Agent github
    github.pr.merge
      repository (any)
          tightened     rule no-merge "Keep merge outside the publisher role": added (deny)
    github.pr.open
      repository exact "acme/widgets"
          granted       rule open-draft "Open a reviewed draft": added (allow)
                        where draft eq true
                        where targetScope eq "candidate"
          tightened     gate reviewed-draft "Require QA, checks and review on the candidate": added: deny until qa: pass since dev; gatekeeper: pass since dev; reviewer: ship since dev
Effective policy:
  …
```

Read the permissions first, then the lines of the effective policy that changed. See [Reading the review](#reading-the-review).

**4. Commit both files.**

```sh
git add nodrail.yaml nodrail.lock.yaml
git commit -m "Let the publisher open reviewed draft pull requests"
```

Reviewers see the same change in the pull request: the manifest, and the lock with the reviewed policy in it.

**5. Export.**

```sh
nodrail policy export --frozen > effective.yaml
```

The export is one ordinary rules file. Check it like any other with `nodrail policy validate effective.yaml`.

**6. Activate it.** Until now nothing governs an agent. Adding a module installs no hook and runs nothing. Agents follow the policy once you point an enforcement point at the export. See [Activate an export](#activate-an-export).

## What the lock checks

`nodrail policy export --frozen` reads only what was locked. Before it prints anything it checks, offline:

- `nodrail.yaml` is the file that was locked;
- each local file has the hash the lock recorded, and nothing was added to or dropped from the imports;
- each catalog module is the locked version, and every one of its files has the locked hash;
- every module has its values;
- the import order and the effective policy are the ones locked;
- the lock wasn't made by a newer engine level than this `nodrail` has.

When anything differs, it prints nothing on stdout, gives the reason on stderr and exits with 1:

```text
nodrail: policies/team.yaml changed since it was locked. Run `nodrail policy lock` to review it.
```

So an export always matches the policy someone reviewed and committed. To change the policy, edit the files, run `nodrail policy lock`, read the review and commit again.

### The workspace

When `nodrail.yaml` sets up hosts, with agents, a team or connections, the lock records more than the policy: it records the workspace the hosts get. It has two digests:

- **The policy** (`effective`): what the hook enforces. `export --frozen` checks only this, as above.
- **The workspace** (`workspace`): one digest over every file the setup is made from, and the effective policy compiled from them. The files are `nodrail.yaml`, every resource and policy file, each connection's code, the catalog modules' files, each agent's instructions, and every file in its skills. Because the policy is included, the same files compiled by another engine into another policy are another revision.

The instructions and skill files are listed under `workspace.files`. Their paths are relative to the project and sorted the same way on every machine, so a copy of the project has the same digests anywhere. Machine paths, secrets, generated files and timestamps are left out. Data a connection reads or writes, such as a `./handbook` folder or a memory file, is not part of the workspace.

`nodrail plan` checks both:

```text
  ✓ policy: matches nodrail.lock.yaml
  ! workspace: changed since it was locked: ~ skills/cite-sources/SKILL.md, + skills/cite-sources/extra.md. Run `nodrail policy lock` to review it.
```

Then `plan` exits with 1 and `apply` refuses, until `nodrail policy lock` records the change and lists it:

```text
Instructions, skills and plugins, compared with the lock:
  ~ skills/cite-sources/SKILL.md
  + skills/cite-sources/extra.md
```

A lock that records the workspace has `lock: 2`. A project with a policy and no setup keeps `lock: 1`, unchanged. If a setup's lock predates workspaces, `plan` asks you to run `nodrail policy lock` once, and `export --frozen` keeps working meanwhile. A `nodrail` older than this one refuses `lock: 2` with a message, rather than misreading it.

### Versions

`nodrail add @nodrail/open-reviewed-pr` takes the catalog's newest version. `nodrail add @nodrail/open-reviewed-pr@1.0.0` asks for that exact version; a version the catalog doesn't have is refused, and nothing changes. Once locked, a module stays at its version, even when a newer `nodrail` brings a newer one: to move to it, add it with its version, such as `@1.0.1`, and review the change.

If a module's files at the locked version don't match the hashes in the lock, `lock` and `export --frozen` both stop:

```text
nodrail: @nodrail/open-reviewed-pr@1.0.1 doesn't match nodrail.lock.yaml (policies/open.yaml). The installed package was changed; reinstall nodrail, or ask for another version with `nodrail add @nodrail/open-reviewed-pr@<version>`.
```

That is an error, never an update. The same version must always mean the same files.

## Reading the review

`nodrail add` and `nodrail policy lock` print what the change does to permissions since the policy last reviewed, grouped by agent, then operation, then resource. Each change has one label.

| Label          | Meaning                                                             |
| -------------- | ------------------------------------------------------------------- |
| `granted`      | An allow that wasn't there: the agent may now do this.              |
| `revoked`      | An allow removed: the agent may no longer do this.                  |
| `tightened`    | Less is allowed: a deny or a gate added, or an allow narrowed.      |
| `loosened`     | More is allowed: a deny or a gate removed, or an allow widened.     |
| `changed`      | It changed, but not simply more or less, such as a mix of both.     |
| `needs review` | The tool can't tell whether it is more or less. Read both versions. |

A `!` before the label marks a change that weakens a deny or a gate, and the count at the top says how many there are. Read those first.

```text
3 permission changes, 1 marked ! weaken a deny, a gate or a budget.
…
      ! loosened      gate review-first "Review first": …
```

After the permissions, `Effective policy:` shows the lines of the exported file that changed, with `+` and `-`.

## Use it in CI

Pin the `nodrail` version you lock with, and build the export from the committed files only. A shell redirect empties the target file before `nodrail` runs, so export to a temporary file and replace the deployed file only on success:

```sh
set -e
nodrail policy export --frozen > effective.yaml.tmp
nodrail policy validate effective.yaml.tmp
mv effective.yaml.tmp effective.yaml
```

A pull request that changes `nodrail.yaml` or a local file without running `nodrail policy lock` fails here, with the reason. To check expected decisions too, run [`nodrail policy test`](../../policy-engine/docs/cli.md#test) against the export with a cases file.

## The catalog

| Module                        | What it does                                                                                                                                                                                 | Values       |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `@nodrail/open-reviewed-pr`   | A publisher agent (`github`) may open draft pull requests after QA, a gatekeeper and a reviewer accept the current candidate. Merging stays denied. Also named `@nodrail/pr_policy.yaml`. | `repository` |
| `@nodrail/merge-reviewed-pr`  | A separate `merger` agent may merge only after QA, the checks and a review pass on the current head.                                                                                         | `repository` |
| `@nodrail/triage-issues`      | A `triage` agent may read issues, comment and label. It can't close, assign, edit code or open pull requests.                                                                                | `repository` |
| `@nodrail/dependency-updates` | A `deps` agent may write lockfiles, refresh them with scripts off, commit, and push its own branch. It never changes package.json or pushes to main. It may open a draft pull request after the checks pass, and can't merge or force-push. | `repository` |
| `@nodrail/read-only`          | The `read-only` starter pack as a module.                                                                                                                                                    | None         |

`repository` is one exact repository, as `owner/name`. A wildcard or a path is refused.

A module that has values to give is reported as `configuration required` until it has them, and `export --frozen` refuses until then.

## Compose with your own files

Add your own rules files next to modules:

```sh
nodrail add ./policies/team.yaml
```

Imports compile in the order `nodrail.yaml` lists them, and `add` appends to the end. Order matters in one way only: a later file can change an entry from an earlier file with `override`. It doesn't change precedence. Deny still wins over review, and review over allow, whatever the order.

Names must be unique across every imported file. Redefining a module's rule or gate without `override` is an error, so a local file can't quietly weaken it.

### Example: one more reviewer

To make `@nodrail/open-reviewed-pr` also wait for a `security` agent, save this as `policies/security.yaml`:

```yaml
# Opening also waits for a security review of the same candidate.
- required_engine_version: 3
- gate: Require QA, checks and review on the candidate
  requires:
    - { agent: security, verdict: pass, since: [dev] }
  override: { requires: append }
```

The gate's name is the module's own. `override: { requires: append }` adds the requirement to the module's three. Add the file after the module and review the change:

```sh
nodrail add ./policies/security.yaml
```

```text
Added ./policies/security.yaml
Changed: nodrail.yaml, nodrail.lock.yaml
Permissions:
  1 permission change.

  Agent github
    github.pr.open
      repository exact "acme/widgets"
          needs review  gate reviewed-draft "Require QA, checks and review on the candidate": requires security: pass since dev
                        security's commands no longer count as changing the work for the other requirements
```

The same `override` can replace a field, such as `otherwise`, or append to a rule's `condition` or `tags`. A replacement can weaken a module's deny or gate: the review marks it `!`. See [Layering files](../../policy-engine/docs/rules.md#layering-files) for every form.

## Give the roles to your agents (preview)

A module's rules name roles, such as `github` or `qa`, not your agents. To run a playbook with your own agents, declare them as resources and bind the module's roles to them. `nodrail.yaml` points at the resources:

```yaml
kind: nodrail.project/v1
runtime: claude-code
resources: ./resources
imports:
  - ref: "@nodrail/open-reviewed-pr"
    with:
      repository: acme/widgets
```

`resources` is a file, a folder of `.yaml` files, or a list of both. Each document in them is one resource:

```yaml
apiVersion: nodrail.com/v1alpha1
kind: Agent
metadata: { name: publisher }
spec:
  description: Opens the draft pull request once the candidate is checked.
  instructions: ./agents/publisher.md
  skills: [./skills/release-notes]
---
apiVersion: nodrail.com/v1alpha1
kind: Team
metadata: { name: release }
spec:
  entry: lead
  members: [lead, publisher, tester, gate, critic, builder]
  handoffs:
    - { from: lead, to: publisher }
---
apiVersion: nodrail.com/v1alpha1
kind: PolicyBinding
metadata: { name: open-prs }
spec:
  policy: "@nodrail/open-reviewed-pr"
  roles:
    github: publisher
    qa: tester
    gatekeeper: gate
    reviewer: critic
    dev: builder
```

| Kind | What it declares |
| --- | --- |
| `Agent` | One agent: its name, `description`, `instructions` (a Markdown file), `skills` (folders with a `SKILL.md`) and `model`. Paths start with `./` and are read from the resource's file. |
| `Team` | The agents that work together, the `entry` agent a session starts as, and the `handoffs`: who may start whom. |
| `Policy` | A rules file of your own, `spec: { source: ./policies/x.yaml }`. It does nothing until a binding names it. |
| `PolicyBinding` | Which agent plays each role a module or Policy names. |

A binding renames the roles everywhere the policy names an agent: a rule's `agent`, a gate's `requires` and `since`, a budget's `step_agent`, and a `kind: agent` resource, such as which agents a role may start. The lock covers the resource files like any other, so a changed binding stops `export --frozen` until it is reviewed and locked again.

`lock` refuses a binding when:

- the policy names an agent that no role maps and no team member is called. `@nodrail/open-reviewed-pr` and `@nodrail/merge-reviewed-pr` also name `dev`, the agent whose later work resets the checkers' verdicts; map it too.
- a role it maps is one the policy never names, which is usually a typo.
- two names the policy uses would be one agent: two roles mapped to one agent, or a role mapped to an agent the policy already names for another. That agent would vouch for its own work.
- a role goes to an agent that isn't on the team.

The team adds rules of its own to the effective policy, after everything else:

- each member may start the members it hands off to, and no other member, itself included. The team's handoffs are the only way work moves between its agents. Agents that aren't on the team, such as a host's built-in ones, are left to the rest of the policy.
- no agent may write, edit, patch or delete the setup: `.claude`, `.codex`, `.agents`, `.nodrail`, `nodrail.yaml` and `nodrail.lock.yaml`, and Copilot's places in `.github` (`agents`, `hooks`, `skills`, `mcp.json`, `copilot`). The rest of `.github`, such as workflows, isn't protected: the hook's guard covers those places by path. An agent that could rewrite an agent definition could make itself that agent.
- no agent may run `nodrail` or `nodrail-policy`, so none can lock and apply a setup it changed.

These are denies, and deny wins, so no other file can widen them. `nodrail apply` also lists every file the setup is made from (the resources, your own policy files, the agents' instructions and skills) in `.nodrail/protected.txt`, and the hook refuses any file tool that would change one, whatever the rules say.

The hook also denies any shell command that names one of those files, or runs Nodrail by any path, whatever the rules allow. It reads the words a command is written with, not what the shell makes of them: a wildcard (`.cl*/`), a path built from a variable (`$D/settings.json`), or a script that writes the file isn't recognised. Whole-project commands such as `git checkout .` or `rm -r .` don't name a setup file either. So the guard stops an agent from editing the setup with its file tools and from naming it in a command; it isn't a sandbox. A policy that allows the shell, or commands that run scripts, can still undo the setup: allow the commands your agents need, not the shell.

An agent's instructions and skills can't live in `.claude`, `.codex`, `.agents` or `.nodrail`: nodrail writes those folders.

`runtime` (`claude-code`, `codex` or `copilot`), or `runtimes: [claude-code, codex, copilot]` for one file several hosts apply, and `start` are for setting up the host. [`nodrail plan`](cli.md#plan-preview) shows what would be set up, without changing anything, and [`nodrail apply`](cli.md#apply-preview) sets it up, on Claude Code or Codex. Only the root `nodrail.yaml` may declare them, and a module nobody binds compiles exactly as before.

### Tool connections (preview)

A connection is a tool server your agents call, such as a search over your own handbook: an MCP server that runs over stdio. Declare it in `nodrail.yaml`, with the operations agents may call and what each one acts on:

```yaml
connections:
  handbook:
    command: node
    args: [./connectors/handbook.mjs]
    env:
      HANDBOOK_URL: http://127.0.0.1:8091/search
      HANDBOOK_TOKEN: { fromEnv: HANDBOOK_TOKEN }
    operations:
      search: { resource: { kind: collection, from: collection } }
agentConnections:
  marketing: [handbook]
  support: [{ connection: handbook, operations: [search] }]
```

Claude Code and Codex call it as `mcp__handbook__search`, and the hook judges each call before the server gets it, as the agent the host says made it: a subagent's call as that subagent. So `search` with `collection: internal` is tool `handbook`, operation `search`, resource `collection` `internal`, and a rule decides it like any other:

```yaml
- rule: Internal handbook for support
  agent: support
  tool: handbook
  operation: search
  resource: { kind: collection, match: exact, value: internal }
  effect: allow
```

A call to an operation the connection doesn't declare, or without the argument its resource comes from, is denied. An agent named in the arguments changes nothing. With `agentConnections`, each member may use only the connections and operations listed for it; the rest of the policy still decides each call. Without it, every member may, and the policy decides.

A secret is a reference, never a value: `{ fromEnv: NAME }`, or on macOS `{ fromKeychain: { service: name, account: name } }`. The host starts the connection with `nodrail connection run`, which reads the secrets then and gives the connection only those and what any program needs (`PATH`, `HOME`, the locale): not the rest of your environment. To rotate one, change the variable or the Keychain entry and start a new session. Every project file the connection's command line names, the command itself included, with or without `./`, or as `--flag=value`, is locked with the policy: the code that gets your secrets is the code you reviewed, and agents' file tools can't change it (see the guard's limits above). A folder it names, such as documents to search, is data: it is read, not locked. A program from `PATH`, such as `node`, isn't part of the project: `plan` shows it as written.

`nodrail plan` starts nothing and reads no secret. It shows each connection's command line, which secret goes to which connection, and whether each is set, never its value. Only `apply`, once you accept the plan, starts each connection once to list its tools, calling none; one that doesn't offer a declared operation, or the argument its resource comes from, stops `apply` before it writes anything. Swapping a connector for another that keeps the same operations needs no change to roles or rules.

### Search connectors (preview)

Nodrail ships two connectors that keep one contract: a `search` tool that takes a `collection`, a `query` and an optional `limit` (1 to 20, 5 by default), and gives back `{ "matches": [{ "collection", "source", "text" }] }`. Either can stand behind a connection, and swapping one for the other is a change to its command line alone: the tool, its operation and its resource stay the same, so roles and rules don't change.

A folder of documents, one subfolder per collection (`handbook/public/returns.md`, `handbook/internal/escalation.md`), searched by the words a passage shares with the query:

```yaml
connections:
  handbook:
    command: nodrail
    args: [connector, files-search, --folder, ./handbook]
    operations:
      search: { resource: { kind: collection, from: collection } }
```

A search service of your own, over HTTP: `nodrail` posts `{ collection, query, limit }` to the endpoint, with `Authorization: Bearer` and the value of `SEARCH_TOKEN`, and reads `{ "matches": [{ "source", "text" }] }` back:

```yaml
connections:
  handbook:
    command: nodrail
    args: [connector, http-search, --endpoint, https://search.example.com/v1/search]
    env:
      SEARCH_TOKEN: { fromEnv: HANDBOOK_TOKEN }
    operations:
      search: { resource: { kind: collection, from: collection } }
```

A failure reaches the agent as a tool error it can report, such as `the search service answered 401` or `there is no collection secret`, never with the token. `files-search --receipts <folder>` adds one line per search to `<folder>/reads.jsonl`, with the collection and the sources it returned and never the query: a count of reads. The connectors are part of the `nodrail` you installed, so their version is its version.

### Memory (preview)

Memory is a connection to a memory provider you choose. Nodrail doesn't store it; it starts the provider, decides who may call it, and keeps its data where you say. With the reference [MCP memory server](https://github.com/modelcontextprotocol/servers/tree/main/src/memory), a knowledge graph in one file, the file is the scope. Give each agent its own:

```yaml
connections:
  support-memory:
    command: npx
    args: [-y, "@modelcontextprotocol/server-memory@2.2.1"]
    env:
      MEMORY_FILE_PATH: ./memory/support.jsonl
    operations:
      search_nodes: {}
      open_nodes: {}
      create_entities: {}
      add_observations: {}
    data: [./memory/support.jsonl]
agentConnections:
  support: [support-memory]
```

A plain `env` value that starts with `./` is a path in the project. Nodrail hands it to the provider whole, because a provider may resolve a relative path against its own install folder. Leave out the operations agents shouldn't have, such as `delete_entities`; a call to one is denied.

`data` names what the provider keeps: files or folders in the project, which needn't exist yet. Nodrail treats them this way:

- **Reached only through the connection.** The hook denies any agent a file tool on them (reading, writing or searching inside them) and any shell command that names them or a folder holding them, whatever the rules say. Otherwise an agent not given `support-memory` could read `memory/support.jsonl` with `Read` or `cat`.
- **Never locked.** Data changes as agents work, so it's left out of the lock and the workspace revision, even when the command line names a file in it.
- **Never removed.** When you take the connection out of `nodrail.yaml`, `apply` removes the connection and keeps its data; `plan` says where it stays. From then on the hook no longer keeps it from agents: move or delete it yourself if they shouldn't reach it.

`data` can't be where nodrail writes (`.claude`, `.codex`, `.agents`, `.nodrail`), and can't overlap what the lock covers: resources, policies, instructions, skills, plugins, or the program the connection runs. `plan` shows it: `keeps ./memory/support.jsonl, which agents reach only through it`. Create the folder before the first session: the reference memory server 2.2.1 fails to write into a folder that isn't there.

These operations name no resource, so a call is `tool: support-memory`, the operation, and resource kind `mcp_tool`. Allow each operation for its agent:

```yaml
- rule: Support remembers (search_nodes)
  agent: support
  tool: support-memory
  operation: search_nodes
  resource: { kind: mcp_tool, match: any }
  effect: allow
```

A new session gets what an earlier one wrote. An agent that isn't exposed to a memory can't call it. `plan` shows the command, and `npx` downloads the version you pinned when `apply` first starts it. When the command is `npx`, `bunx` or `uvx` and the package has no exact version (`@modelcontextprotocol/server-memory`, `@latest`, `^2.0.0`), `plan` marks the connection `?`: each start may fetch another release than the one you reviewed. It doesn't stop `apply`. To use a hosted provider, give its MCP server's command line and its key as `{ fromEnv: … }`.

### Plugins (preview)

A plugin is a folder in your project that each host loads: skills, and MCP servers with their tools. Declare it with the operations its servers offer, as for a connection, and who may use it:

```yaml
plugins:
  desk-kit:
    source: ./vendor/desk-kit
    servers:
      ledger:
        operations:
          record: { resource: { kind: ledger_line, from: line } }
agentPlugins:
  support: [desk-kit]
```

The folder holds a manifest for each host you set up: `.claude-plugin/plugin.json` and `.codex-plugin/plugin.json`, each naming the plugin as declared and bringing each declared server. Claude Code reads a plugin's servers from `.mcp.json` and expands `${CLAUDE_PLUGIN_ROOT}` in them. Codex doesn't: give its manifest its own file, with `"cwd": "."` and paths relative to the plugin. `plan` refuses a plugin whose manifests don't match the declaration.

`apply` makes the project a marketplace named `nodrail-<team>` that lists the plugin from its folder: `.claude-plugin/marketplace.json`, and `.agents/plugins/marketplace.json` for Codex. It then switches the plugin on in the host's settings: `extraKnownMarketplaces` and `enabledPlugins` in `.claude/settings.json`, next to your own entries; `[marketplaces]` and `[plugins]` in `.codex/config.toml`. Nothing is installed.

- **Claude Code** loads the plugin once you trust the folder.
- **Codex** lists it then, but loads it only once you install it with `codex plugin add desk-kit@nodrail-<team>` in the folder. That installs it for your user and enables it in every folder, so nodrail never runs it for you. `plan` shows the command as `? plugin desk-kit`, and `✓` once Codex has that version.

The hook reads a plugin's tool calls by the server's name, however the host names them: `mcp__plugin_desk-kit_ledger__record` on Claude Code, `mcp__ledger__record` on Codex. So a rule says `tool: ledger, operation: record`, and a call with no `line` is refused. A server's name must differ from every connection's and every other plugin's, because Codex names them alike. Each member given the plugin may load its skills (`desk-kit:<skill>`). With `agentPlugins`, any other member is denied the plugin's operations; without it, every member may use it.

The plugin's files are part of the [workspace](#the-workspace): changing one stops `apply` until `nodrail policy lock`. They are kept from agents, like the rest of the setup.

#### A plugin from git

For a plugin someone else publishes, say where it comes from, at one commit:

```yaml
plugins:
  commit-commands:
    source: ./vendor/commit-commands
    from:
      git: https://github.com/anthropics/claude-plugins-official
      commit: "df9699a55c56707e9948a32951ea356638ea8519"
      path: plugins/commit-commands
```

`commit` is a full commit id, in quotes so YAML reads it as text. A branch or tag is refused: it can move to code nobody reviewed. `path` is the plugin's folder in the repository; leave it out when the plugin is the whole repository.

`nodrail plugin fetch` copies the plugin's files at that commit into `source`. It shows what it adds, changes and removes there, and asks first. It reads the files from git's objects without checking anything out, so nothing in the repository runs, and it refuses links and submodules. Then:

1. `nodrail policy lock` shows each of the plugin's files for you to review, and records them.
2. `nodrail apply` sets it up like a plugin of your own.

Commit the folder: a teammate then gets the reviewed files with the project, with no network and no fetch.

To update, change `commit` and run `nodrail plugin fetch` again; the lock shows what changed. `nodrail plugin fetch --check` compares the folder with its commit and changes nothing: it exits 1 when they differ, for CI. `plan` doesn't go to the network, so it marks such a plugin `?` and names that command. A file changed in the folder since the lock still stops `apply`, as for any plugin.

### Observation (preview)

`nodrail status` shows each host as `apply` set it up, next to what is there now (see the [CLI reference](cli.md#status-preview)). `apply` also adds a session-start hook on each host that runs `nodrail observe`. That records the project's latest status in `~/.nodrail/observations/`, so the last reading is never older than the last session:

```yaml
observe:
  names: true          # also record names of what nodrail doesn't manage
  sessionStart: false  # no session-start hook
```

- **Counts by default.** A record holds, per host: the revision, whether the hook runs, how many files changed since apply, and how many agents, skills, MCP servers, plugins and hooks the host loads that nodrail doesn't manage. Names only with `names: true`: they say which tools a person uses, so it's the project's choice. Never contents, environments or secrets.
- **Never in the way.** The hook starts `nodrail observe` apart and returns at once. Observing never fails, and never changes the project. `nodrail status` shows when it last recorded, and calls a record older than 24 hours stale.
- **Codex** asks you to trust the new hook once: open `codex` in the folder and run `/hooks`. Until then it doesn't run, and the policy hook is unaffected. `nodrail status` says which.
- **Sent only with telemetry.** Without `telemetry:` a record stays on the machine. With it, each record also goes to the same receiver as the decisions: one `nodrail.observation` span per host, one trace per record, with `nodrail.machine` (a random id kept in `~/.nodrail/machine-id`, never the hostname), `nodrail.host`, `nodrail.agent`, `nodrail.activation`, `nodrail.in_step`, `nodrail.drift`, `nodrail.workspace.revision`, `nodrail.workspace.locked` and `nodrail.unmanaged.<kind>` counts. With `names: true`, also `nodrail.drift.names` and `nodrail.unmanaged.names` (JSON lists, at most 4,000 characters). Never the project's path or anything under home. Offline, records wait in the same bounded queue as decisions.
- **Your team's inventory.** The Nodrail control plane, self-hosted or Nodrail Cloud, is one such receiver.
  1. Create a reporting token: API tokens → `inventory:write`, chosen alone. It reads nothing.
  2. Give the project an `id:` in nodrail.yaml.
  3. Point `telemetry:` at `<your Nodrail address>/api/v1/otlp/v1/traces?environment=<slug>` (`https://app.nodrail.com` on Nodrail Cloud), with `bearer: { fromEnv: NODRAIL_TOKEN }` and the raw token in that variable.

  The **Inventory** page then shows each person's machines, project by project, and Activity → **Reported locally** shows each decision and local run. All of it is evidence of local enforcement, recorded rather than decided again. Admins and policy managers see everyone; others see their own. `nodrail workspace publish` marks which locked revision the team should run.

### Telemetry (preview)

Nodrail can send each decision its hook makes to any OpenTelemetry receiver: a backend that takes OTLP, or a Collector you run, which routes it on.

```yaml
id: 3f1c2a8e-5b7d-4e0f-9a6c-1d2e3f405162   # the project's stable id: make one once and commit it
telemetry:
  traces:
    endpoint: http://127.0.0.1:4318/v1/traces
    protocol: otlp-http/protobuf   # or otlp-http/json
    bearer: { fromEnv: NODRAIL_TOKEN }       # sent as "Authorization: Bearer <raw token>"
    headers:                                 # or any header, sent as written
      x-collector-key: { fromEnv: OTLP_KEY }
```

`bearer` takes a raw token and adds `Bearer `, so `NODRAIL_TOKEN` can hold the same `ndp_` token the CLI reads. `headers` are sent as written, for collectors that want something else. Without an `id`, reports name the project by its folder only: a clone, a rename or another project of the same name can't be told apart. `plan` suggests an id to add.

Each export carries `service.name` `nodrail`, `nodrail.schema` `2`, the project's folder name and its `id`. Each decision is one span, `nodrail.decision`. It carries what the host can't know: the decision the host was told (`nodrail.decision`: allow or deny), what the rules said (`nodrail.match`, `none` when no rule did), the rule, the agent it was judged as, the tool, operation and kind of resource, the host, and the policy's revision. It carries the policy's revision two ways. `nodrail.policy.revision` is the effective policy file's full SHA-256, the same digest the lock records. `nodrail.revision` is the older short hash, kept for old receivers and never compared. Each decision also carries the machine's random id, and the run and step when the rules keep a run ledger.

It also carries the ids the host's own telemetry uses, `session.id`, `gen_ai.conversation.id` and `gen_ai.tool.call.id`. A backend that also receives Claude Code's or Codex's own telemetry can then join each decision to the call it was about. A call's arguments, the resource it names, prompts and secrets are never sent.

With gates or budgets, each step and action the run ledger records is a `nodrail.run.event` span. It carries the event, the agent, the step, the verdict and the number of findings (never their text), usage, and the action's tool, operation and outcome. The run is named by a hash of its key, never by the repository or branch in it.

The hook doesn't wait on the network. It adds the span to a queue in `~/.nodrail/telemetry/`, and a separate process sends it. When the receiver is down, decisions go on exactly as before.

`nodrail plan` says how sending went:
- **kept:** spans the receiver accepted.
- **refused:** spans the receiver rejected, either as an OTLP partial success or with a 4xx. They are never sent again, and the receiver's reason is shown.
- **no readable answer:** the receiver answered, but whether it kept the spans is unknown.
- **dropped:** spans never sent, because the queue passed 512 KiB.

A receiver that is down or busy (408, 429, 5xx, no connection) gets the same spans again, with the same ids, after 30 seconds. A receiver that deduplicates, like Nodrail's, keeps each once. A batch the receiver partly accepted is never resent.

Claude Code and Codex can export their own telemetry too, which this doesn't switch on. Both send the person's email and account ids with every record, and Codex sends each tool call's arguments and output: route theirs through a Collector that drops what you don't want sent.

### Connect to Nodrail (in progress)

`connect:` names the control plane the project is connected to, a self-hosted Nodrail server or Nodrail Cloud, and who decides each call:

```yaml
connect:
  url: https://app.nodrail.com       # or your self-hosted address; Nodrail Cloud when left out
  workspace: acme                     # slugs, as in /app/<workspace>/<environment>
  environment: development
  decide: cloud                       # cloud: the control plane decides, with its runs and budgets | local: this machine
  enforce: on                         # on | watch: record what would be blocked, block nothing
  credential: { fromEnv: NODRAIL_CREDENTIAL }   # the agent credential (ndr_…), never written
```

`decide` has no default, so nobody is surprised by who decides. `plan` says it in words. With a credential, `plan` asks Nodrail whose credential it is, and fails when it belongs to another workspace or environment. It never prints the credential. When Nodrail can't be reached, the credential stays unchecked, not failed.

With `decide: cloud`, the locked policy is what Nodrail runs. `plan` compares the live version with the lock: in sync, apply publishes, or drift when the rules were changed in Nodrail. Each version `apply` publishes names this project's `id` and lock, so the next `plan` can tell. Your own token publishes it, never the agent's credential. See `plan` in [the CLI reference](cli.md).

With `decide: cloud`, `apply` sets up Claude Code with the **connected hook** (`nodrail connect hook`) instead of the local one:

- **Before every call**, the local guards run first, exactly as in the local hook: the protect list, the setup, the run ledger, git's folders and the connections' data. A call they refuse never leaves the machine.
- **Everything else is decided by Nodrail**, with the same client hook the plugin ships. A call is allowed or denied at once, with the reason; nothing waits for a person. A call Nodrail hasn't answered in 25 seconds is denied.
- **Subagent steps and call outcomes** go to Nodrail too, so its Runs show the run, its receipts and its budgets.
- `.nodrail/connect.json` holds the address and the credential's **reference**, never the credential. Set `NODRAIL_CREDENTIAL`, or the variable you named, where Claude Code runs. Without it, every call is blocked, never let through.
- `apply` publishes the locked policy first. When the live policy can't be checked (no token, Nodrail unreachable), it refuses rather than install a hook against rules nobody compared with the lock.

`decide: cloud` sets up Claude Code only for now; `plan` refuses it for Codex and Copilot. `enforce: watch` is checked but still refused.

### Tested versions (proposed)

A workspace can say which exact versions it was tested with, so whoever sets it up knows whether their machine matches:

```yaml
tested:
  nodrail: 0.5.0
  node: 22.22.3
  claude-code: 2.1.328
  codex: 0.170.0
```

`nodrail plan` compares this `nodrail`, the Node running it, and the host it sets up:

```text
  ✓ tested: runs as tested: nodrail 0.5.0, node 22.22.3, claude-code 2.1.328
  ? tested: unverified here: claude-code 2.1.330 (tested 2.1.328)
```

Any other version is unverified, not refused: `?` doesn't block `apply`, and it shows as `"unverified": true` in `plan --json`. Using a newer host is your choice; the minimum versions above still apply. A host the profile doesn't name is also unverified. Each version is exact, such as `2.1.328`. The field is a proposal until the workspace milestone ships; its name and shape may change.

## Activate an export

Agents follow a playbook only through an enforcement point that reads the export. Which one depends on the calls the playbook covers.

**File and shell rules** work with the local Claude Code hook today. That covers `@nodrail/read-only` and the file part of `@nodrail/dependency-updates`. Point the hook from [Write and test rules locally](../../policy-engine/docs/getting-started.md#connect-claude-code) at the export:

```sh
nodrail policy hook effective.yaml
```

`nodrail-policy hook effective.yaml` does the same. The hook blocks any call no rule covers, so the export needs rules for every shell and file call your agent makes. Import those with the module, such as your own rules file or `@nodrail/read-only`, rather than loading a second file next to the export.

**GitHub rules** describe calls with tool `github`, operations such as `pr.open`, `pr.merge` or `issues.comment`, and resource kind `repository` with the id `owner/name`, as in the [policies guide](https://nodrail.com/docs/policies). They take effect only where an adapter maps your agents' GitHub calls to those names and supplies the run evidence the gates need: which candidate or head is being acted on, and the verdicts of QA, the checks and review for it. The local Claude Code hook doesn't map GitHub calls. An agent's own GitHub credentials don't go through these rules at all, so the merge and triage modules deny those agents the shell, where `gh` and `git push` would run. See [Runs, gates and budgets (preview)](../../policy-engine/docs/runs.md) for the evidence a gate reads.

## Limits

- **Nothing runs until you activate an export.** `add`, `lock` and `export` change files and print text. They install no hook and govern no agent.
- **A module is only as good as its enforcement point.** A GitHub module's guarantees cover the calls that go through a trusted adapter, with evidence that adapter supplies. Calls that bypass it aren't seen.
- **Agent names are reported, not authenticated.** `github`, `merger` or `triage` are the names your integration gives the caller. Read [the security model](../../policy-engine/docs/security-model.md) before relying on them.
- **Gates need engine level 3**, which is a preview. Receipts are self-reported: a gate proves a step reported a verdict, not that the work was good.
- **With the local hook, checkers vouch for themselves.** The hook judges a subagent's call as the subagent Claude Code or Codex says made it, and the session's other calls as its `--agent`. A verdict, though, is whatever the checker's last message said. The modules stop the gated roles (`github`, `merger`, `deps`) from starting their own checkers, but a guarantee that QA, the checks and review really ran on the candidate needs an adapter that collects that evidence on the host, outside the agent's reach.
- **Protect the policy itself.** Agents shouldn't be able to edit `nodrail.yaml`, `nodrail.lock.yaml`, the files they import, the resources and the agent definitions they set up, or the exported policy. A team set up with `nodrail apply` protects all of these from file tools; without one, the `repo-work` starter pack protects the first two; `nodrail policy lock` compares with the lock as last committed in git, so a change an agent made and locked shows up in the review.
- **The lock covers files, not people.** It proves the export matches what was committed. Who may change `nodrail.yaml`, the lock and the deployed export is up to your repository's review rules. Keep them out of the agent's reach.
- **The catalog comes with `nodrail`.** The modules you can add are the ones bundled in your installed version. There is no registry, and nothing is downloaded.
