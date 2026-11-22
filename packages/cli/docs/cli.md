# CLI reference (nodrail)

`nodrail` is Nodrail's one command line. It has three parts:

- **Project commands**, offline: `nodrail add`, `nodrail policy lock` and `nodrail policy export --frozen` manage a repository's policy from catalog modules and your own files. See [Playbooks](playbooks.md).
- **Policy commands**, offline: `nodrail policy init`, `validate`, `compile`, `eval`, `test`, `check`, `exec`, `hook` and `runs` check and apply a rules file on your machine.
- **Cloud commands**, with a personal token: `login`, `approvals`, `approve`, `reject`, `activity`, `runs`, `run`, `insights` and `rules pull` or `rules push` work with your Nodrail Cloud workspace.

The project and policy commands need no account and send nothing anywhere.

`plan` and `apply` (preview) set up a workspace on Claude Code or Codex. For the versions they have been tested with, what each host proves, migration notes and limits, see [Compatibility](compatibility.md).

Receipt contracts are enforced by the hook on Claude Code and Copilot; briefs and `nodrail contracts render`, `validate` and `explain` are a preview: see [Declared contracts](contracts.md).

## Install

Use Node.js 22 or later.

```sh
npm i -g @nodrail/cli
nodrail --help
```

With pnpm, run `pnpm setup` once so pnpm has a folder for global commands, then `pnpm add --global @nodrail/cli`.

`nodrail --version` prints the version. `nodrail --help` lists every command.

## Project commands

Run these in the folder that holds `nodrail.yaml`, usually the root of your repository. [Playbooks](playbooks.md) explains the project files, the lock and the review output.

| Command                           | What it does                                                   | Exit code                                   |
| --------------------------------- | -------------------------------------------------------------- | ------------------------------------------- |
| `add <@nodrail/module \| ./file>` | Adds a catalog module or a local file, and updates the lock    | 0 done, 1 refused                           |
| `policy lock`                     | Shows the permission changes since the last lock, records them | 0 done or up to date, 1 refused             |
| `policy export --frozen`          | Prints the locked policy as one APF file                       | 0 printed, 1 anything differs from the lock |
| `example` (preview)               | Copies an example project out of the package                   | 0 copied, 1 the folder isn't empty          |
| `plan` (preview)                  | Shows what `nodrail apply` would set up for the team           | 0 could apply, 1 something blocks it (or, with `--require-active`, the policy isn't enforced) |
| `apply` (preview)                 | Sets the team up on its host, after showing the plan           | 0 done or nothing to do, 1 refused          |
| `destroy` (preview)               | Takes out what `apply` set up, after showing what              | 0 done or nothing to do, 1 refused          |
| `observe <folder>` (preview)      | Records the project's status in `~/.nodrail/observations/`; the session-start hook runs it | always 0 |
| `status` (preview)                | Each host as `apply` set it up, next to what is there now      | 0 in step and enforced, 1 drift, an older revision, the policy not enforced, or nothing set up |
| `plugin fetch [name]` (preview)   | Copies a plugin from git at its pinned commit                  | 0 done or matches, 1 refused or (`--check`) differs |

Usage mistakes exit with 2, such as `policy export` without `--frozen`.

### `add`

```sh
nodrail add @nodrail/open-reviewed-pr
nodrail add @nodrail/open-reviewed-pr@1.0.0
nodrail add ./policies/team.yaml
```

`add` writes `nodrail.yaml`, creating it when it is missing, and `nodrail.lock.yaml`. It works offline: the catalog ships inside the package. A module is added once, under its own name, even if you add it again or by another name. Comments, entries and their order in `nodrail.yaml` are kept.

A module that needs values is added with them empty and is reported as `configuration required`. Give them under `with:` in `nodrail.yaml`, then run `nodrail policy lock`.

`@nodrail/x@1.0.0` asks for that exact version. A version the catalog doesn't have is refused, and nothing changes.

A local import is a `.yaml` file inside the project, written as `./` or `../` and a path. A file outside the project, including through a link, is refused. So are an import cycle and a set of files that doesn't compile. When `add` refuses, both files stay as they were.

`add` changes the project's files only. It installs no hook and runs nothing.

### `policy lock`

```sh
nodrail policy lock
```

`lock` compiles the project, prints who gains or loses which actions since the last lock, then the lines of the effective policy that changed, and records the result in `nodrail.lock.yaml`. When nothing changed it prints `nodrail.lock.yaml is up to date.` and writes nothing.

It refuses when a catalog module's files don't match the hashes in the lock at the same version, when a value isn't valid, such as a wildcard where a module needs one exact repository, or when the project doesn't compile.

### `policy export --frozen`

```sh
nodrail policy export --frozen > effective.apf.yaml
```

`export --frozen` checks every file against the lock, offline, and prints one ordinary APF file on stdout. It refuses, printing nothing on stdout and the reason on stderr, when:

- `nodrail.yaml` or a local file changed since it was locked, or a locked file is no longer imported;
- a catalog module's files don't match the lock;
- a module still needs a value;
- the lock was made by a newer engine level than this `nodrail` has;
- a change to the project was interrupted.

Each message says what to run next, usually `nodrail policy lock`.

A shell redirect empties the target file before `nodrail` runs. In CI, export to a temporary file and replace the deployed file only on success:

```sh
nodrail policy export --frozen > effective.apf.yaml.tmp && mv effective.apf.yaml.tmp effective.apf.yaml
```

### `example` (preview)

```sh
nodrail example
nodrail example support-desk ./desk
```

Lists the example projects shipped in the package, or copies one into a new or empty folder, with its lock, ready for `nodrail plan ./desk --runtime claude-code` or `--runtime codex`. Nothing is fetched. `support-desk` is a two-agent team, marketing and support, with a skill, a handbook to search, an outbox to publish to and a policy that decides who may do which; its README is a walkthrough on both hosts, including swapping the handbook for a search service of your own.

### `plan` (preview)

```sh
nodrail plan
nodrail plan ./project --runtime codex
nodrail plan --json
```

`plan` reads the [team's resources](playbooks.md#give-the-roles-to-your-agents-preview) and shows what `nodrail apply` would set up for the host `runtime` names. It only reads: it writes no file and installs nothing. It plans the project in this folder, or in the folder you name.

One `nodrail.yaml` can set up several hosts with `runtimes: [claude-code, codex, copilot]`; then `--runtime` picks one, on `plan` and on `apply`. Without it, or with a host the file doesn't list, nothing is planned. Each host keeps its own record of what it wrote, so both can be set up in the same folder: a file both need, such as the effective policy, is shared, and a file one host no longer needs stays while the other uses it. For `runtime: claude-code` it plans:

| File | What it holds |
| --- | --- |
| `.claude/agents/<name>.md` | Each team member: its description, model, skills to preload, and its instructions as the body |
| `.claude/skills/<skill>/` | Each member's skill folders, copied |
| `.nodrail/effective.apf.yaml` | The locked policy, exactly what `policy export --frozen` prints |
| `.nodrail/protected.txt` | Every file the setup is made from, and every host's folders (`.claude`, `.codex`, `.agents`, `.nodrail`), which the hook keeps from agents |
| `.claude/settings.json` | `"agent"` set to the team's entry agent, and a `PreToolUse` hook running `nodrail policy hook` on that policy with `onFailure: "block"`. Other settings and hooks stay as they are. |

With [tool connections](playbooks.md#tool-connections-preview), it also plans `.nodrail/connections.json`, which the hook reads, and, for Claude Code, each connection in `.mcp.json` and in `enabledMcpjsonServers` in `.claude/settings.json`, next to your own servers; for Codex, in `[mcp_servers]` in `.codex/config.toml`. It shows each connection's command line and which secret it gets, checks that each secret is set, and starts nothing: `apply` starts each connection once to list its tools, only after you accept. With [telemetry](playbooks.md#telemetry-preview), it plans `.nodrail/telemetry.json`, passes it to both hosts' hooks, checks the header secrets, and says how sending went.

Each file is marked `+` to create, `~` to update, `-` to remove, `=` unchanged, or `!` when apply would refuse. A file that already holds exactly what nodrail would write is `=` and stays yours: nodrail never removes it later. Settings behind a link, or with `disableAllHooks` on, are `!`. apply updates or removes only files it wrote, as recorded in `.nodrail/setup-state.json`, and only while they still hold what it wrote. A file already there that nodrail didn't write, one edited since, a path through a link, and an `"agent"` setting someone else chose are all `!`.

It also checks that the policy matches the lock, that `claude` 2.1.295 or later and `nodrail` are on `PATH` (the hook runs `nodrail`; with `onFailure: "block"`, a missing one blocks every tool call), and that skills hold no links. `plan` exits with 1 when anything is marked `!`.

For `runtime: codex` it plans:

| File | What it holds |
| --- | --- |
| `.codex/config.toml` | The entry agent's instructions as `developer_instructions`, and its model. The session you start is the entry agent. |
| `.codex/agents/<name>.toml` | Each other member: name, description, instructions and model |
| `.agents/skills/<skill>/` | Each member's skill folders, copied |
| `.codex/hooks.json` | A `PreToolUse` hook running `nodrail policy hook` on the policy |
| `.nodrail/effective.apf.yaml`, `.nodrail/protected.txt` | The locked policy and the protected files, the same as for Claude Code |

nodrail owns these files whole: one that is already there and wasn't written by nodrail is `!`. A rule that needs a person's review is a deny on Codex, because Codex can't ask: the hook runs with `--host codex`. It checks for `codex` 0.169.0 or later.

Codex runs a project's config and hooks only after you trust them, and nodrail never does that for you. Until you have, Codex runs your agents without the policy. Once `apply` has written the files:

1. Open `codex` in the folder and trust it.
2. Run `/hooks` in Codex and trust nodrail's hook.

`plan` and `apply` ask Codex whether it runs nodrail's hook here, through `codex app-server`, without changing anything. Until it does, `plan` says which step is missing and `apply` exits with 1 after writing the files. The hook names the policy by its full path, because Codex runs hooks in the folder you started it in; after moving the project, run `apply` again and trust the hook again. When Codex can't run `nodrail` at all, the hook answers with a deny, so Codex blocks the call rather than letting it through. Codex reads files through its shell (`cat`, `sed -n`, `rg`): the hook judges those as the file reads they are, so a policy that allows reading files lets Codex read them, and the same secret rules hold. Codex on Windows isn't set up yet.

For `runtime: copilot` (GitHub Copilot CLI) it plans:

| File | What it holds |
| --- | --- |
| `.github/agents/<name>.agent.md` | Each member: name, description and instructions. Start the session as the entry agent with `copilot --agent <entry>`. |
| `.github/skills/<skill>/` | Each member's skill folders, copied |
| `.github/mcp.json` | The connections, as MCP servers nodrail starts, when there are any |
| `.github/hooks/nodrail.json` | A `preToolUse` hook running `nodrail policy hook --host copilot` on the policy, and the session-start observer |
| `.nodrail/effective.apf.yaml`, `.nodrail/protected.txt` | The locked policy and the protected files, the same as for the other hosts |

- **How calls are judged:** the hook reads each of Copilot's calls as the Claude Code call it is, so the same rules decide. `bash` is `Bash`, `view` is `Read`, `create` is `Write`, `edit` is `Edit`, `rg` is `Grep`, `task` is a subagent, and `<server>-<tool>` is the connection's tool. An `apply_patch` is judged once per file it names, and the first deny wins.
- **No asking:** a review is a deny, because Copilot's hook can't ask.
- **Failures:** a hook that fails denies the call. A hook that times out lets it through, so the hook allows itself 20 seconds.
- **Agent identity:** Copilot doesn't say which agent made a call, so every call, a subagent's included, is judged as the entry agent's.
- **Plugins** aren't set up for Copilot yet.
- **Version:** it checks for `copilot` 1.0.114 or later.

Copilot runs a project's hooks and MCP servers only in a folder you trust, and nodrail never trusts it for you. Open `copilot` in the folder and choose to remember it. `plan` and `status` read Copilot's trusted folders (`trustedFolders` in `~/.copilot/config.json`) to say whether it runs nodrail's hook here. A `disableAllHooks` in `.github/copilot/settings*.json`, `.claude/settings*.json` or `~/.copilot/settings.json` is shown as `!`. Copilot also runs a project's Claude Code hooks: nodrail's then judges Copilot's calls the same way.

#### Revision, activation and the other host

`plan` starts with the reviewed revision it sets up, from the lock: `Revision: workspace 0d3971b91508, policy 2e28ae1c4035`. `apply` records it for the host in `.nodrail/setup-state.json`, so `plan --json` shows both the revision it would set up (`revision`) and the one each host here was last applied from (`applied`).

Whether apply *could* go ahead (`ready`, the exit code) is one question; whether the host enforces the policy is another. `plan` ends with the second as `Policy hook: <state>, <why>`, and `--json` gives it as `activation`:

| State | Meaning |
| --- | --- |
| `verified` | The host said it runs nodrail's hook here. Codex is asked. |
| `configured` | The hook is in place and no settings file turns hooks off: `disableAllHooks` in `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR`), `.claude/settings.local.json` or the managed settings, or `allowManagedHooksOnly` in the managed settings. Claude Code has no trust step and can't be asked. |
| `inactive` | It doesn't run yet; the reason says what to do, such as trusting the hook in Codex or running `apply`. |
| `unknown` | The host couldn't be asked, such as `codex` missing from `PATH`. |

`plan` exits with 0 whenever apply could go ahead, whatever the activation. For automation that must not run agents without the policy, add `--require-active`: `plan` then also exits with 1 unless the state is `verified` or `configured`. The `active` key stays as before: `true` or `false` for Codex, `null` for Claude Code.

When both hosts are set up in the folder, a change to the shared policy reaches the other host's open sessions at their next tool call; `plan` says so before you apply. If the other host's agents and skills were applied from an older revision, `plan` names the `apply --runtime` that brings them up to date. If `.nodrail/setup-state.json` is missing while nodrail's files are there, `plan` says so: nodrail takes none of them for its own, and overwrites nothing, until you restore the state from git or move the files aside. A damaged state stops `plan` with what to do.

### `apply` (preview)

```sh
nodrail apply
nodrail apply ./project --runtime claude-code
nodrail apply --yes
```

`apply` shows the same plan, asks before changing anything, and makes exactly those changes. It refuses while anything is marked `!`, and changes nothing then. Without a terminal it needs `--yes`, which you give once you have read `nodrail plan`; `--json` needs `--yes` too.

It runs as the project's only writer, like `add` and `lock`: a second `nodrail` waits its turn and names the one at work. Inside, it plans again, and if anything differs from what you were shown, it stops without changing anything. Every change is staged first in a journal in your home folder, then made one file at a time, with `.nodrail/setup-state.json` last. If it stops partway, the next `nodrail apply` or `nodrail policy lock` finishes it. A file someone changes while it runs is left alone and named.

Run it again after changing a resource, a skill or a binding, and lock the policy first: it updates only the files that changed and removes the ones no longer needed, such as a member who left the team. With nothing to change it writes nothing.

With `start: true` in `nodrail.yaml` and a terminal, it then opens the host. Otherwise run `claude` or `codex` in the folder: it starts as the entry agent, behind the policy hook. For Codex, `apply` is done only once Codex runs nodrail's hook; see above.

A session that is already open keeps the agent files, skills and settings it started with, and `apply` says when it changed any: start a new session to use them. The policy is different: the hook reads it at every tool call, so a policy change applies to open sessions from their next call.

To go back to an earlier setup, put back the resources, skills and policy files as they were, for example with `git checkout <commit> -- nodrail.yaml nodrail.lock.yaml resources skills policies`, then run `nodrail apply`. The setup is made from those files alone, so `apply` writes the earlier files back exactly. Files that were yours before nodrail never changed, so there is nothing of yours to restore.

The policy has to cover every call your agents make, including the ones your own instructions ask for. If your user-wide instructions, such as `~/.codex/AGENTS.md` or `~/.claude/CLAUDE.md`, have agents run a command at the start, that command is blocked like any other until a rule allows it.

### `destroy` (preview)

```sh
nodrail destroy
nodrail destroy --runtime codex
nodrail destroy ./project --yes
```

`destroy` takes out what `apply` set up, for every host it set up here, or only the one `--runtime` names. It shows each file and what happens to it, asks, and then makes exactly those changes, as the project's only writer, like `apply`. It reads `.nodrail/setup-state.json`, not `nodrail.yaml`, so it works even when the setup no longer reads.

- **Removed:** the files nodrail wrote that still hold what it wrote, and nodrail's entries in `.claude/settings.json` and `.mcp.json`: the agent it set, its hook, its servers, marketplaces and plugins. A settings file left with nothing is removed, and so is a folder left empty.
- **Kept:** your own entries and files; any file you edited since nodrail wrote it (marked `!`, and yours from then on); `nodrail.yaml`, `nodrail.lock.yaml` and the files they name; each connection's data, which `destroy` names. A file the other host still needs stays for it.
- **Yours to do:** a plugin you installed with `codex plugin add` is installed for every folder, so `destroy` names the `codex plugin remove` to run and doesn't run it.

Sessions already open keep what they started with. Run `nodrail apply` to set everything up again.

### `status` (preview)

```sh
nodrail status
nodrail status ./project --runtime codex
nodrail status --json
```

For each host `apply` set up here, `status` shows:

- **The revision** it was applied from, and whether the lock has moved on since.
- **The policy hook**: `verified` (Codex says it runs it), `configured` or `inactive`, as `plan` reports it.
- **What changed since apply**: a file nodrail wrote that was edited (`~`) or removed (`-`), and nodrail's entries in Claude Code's settings that are gone or switched off (`!`).
- **What nodrail doesn't manage**: agents, skills, MCP servers, plugins and hooks the host also loads, in this folder or for you in every folder. The hook still decides their tool calls; they just aren't part of the reviewed setup.

It also says whether the session-start observation is on, and when it last recorded (stale after 24 hours); see [Observation](playbooks.md#observation-preview).

It reads only, offline, and changes nothing. It shows names and places, never a file's contents, a server's environment or a secret. For Codex, it asks Codex which hooks it runs, as `plan` does. It reads `.nodrail/setup-state.json`, so it works even when `nodrail.yaml` no longer reads. Use `--json` in scripts; the exit code is 0 only when every host is in step and enforced.

### `plugin fetch` (preview)

```sh
nodrail plugin fetch
nodrail plugin fetch desk-kit --yes
nodrail plugin fetch --check
```

For each plugin `nodrail.yaml` says comes from git (`from: { git, commit, path }`), or the one named, `plugin fetch` reads the plugin's files at that commit and shows what it would add, change and remove in its folder. After you agree, the folder holds exactly those files. Then run `nodrail policy lock` to review them. `--check` writes nothing and exits 1 when a folder differs from its commit. It needs `git`. See [A plugin from git](playbooks.md#a-plugin-from-git).

### `evidence` and `budgets` (engine level 5)

```sh
nodrail evidence run ci-tests -- npm test
nodrail evidence show ci-tests
nodrail evidence submit ci-tests --result result.json --workspace <id> -e production   # in GitHub Actions
nodrail budgets status
nodrail budgets reconcile claude-code:toolu_01… --released --note "the outbox has no such message"
```

Offline except `submit`, and run by a person, never an agent: the setup guard refuses `nodrail` to agents. `evidence run` records what a check wrote to `$NODRAIL_EVIDENCE_OUT` about the current revision; `submit` sends a CI result to Cloud with the job's OIDC token. `budgets status` reads the local run ledger; `reconcile` settles a reservation whose outcome is unknown. See [evidence.md](evidence.md) and [budgets.md](budgets.md).

## Policy commands

`nodrail policy <command>` is [`nodrail-policy <command>`](../../policy-engine/docs/cli.md), the command line of the open-source engine: the same commands, flags, output and exit codes. It uses no token.

| Command                                      | Reference                                                            |
| -------------------------------------------- | -------------------------------------------------------------------- |
| `policy init <pack>`                         | [Commands and exit codes](../../policy-engine/docs/cli.md)           |
| `policy validate`, `compile <rules>`         | [Commands and exit codes](../../policy-engine/docs/cli.md)           |
| `policy eval <rules>`                        | [`eval`](../../policy-engine/docs/cli.md#eval)                       |
| `policy test <rules> --cases <file>`         | [`test`](../../policy-engine/docs/cli.md#test)                       |
| `policy check`, `exec <rules> -- <program>`  | [`check` and `exec`](../../policy-engine/docs/cli.md#check-and-exec) |
| `policy hook <rules>`                        | [`hook`](../../policy-engine/docs/cli.md#hook)                       |
| `policy runs [list \| show <run> \| report]` | [`runs`](../../policy-engine/docs/cli.md#runs)                       |

```sh
nodrail policy init repo-work > rules.yaml
nodrail policy validate rules.yaml
nodrail policy eval rules.yaml --command "git status"
nodrail policy check rules.yaml -- git status
nodrail policy --help
```

`nodrail-policy` keeps working. Hooks and plugins that run it by name need no change, and both answer Claude Code byte for byte alike. Installing `@nodrail/cli` doesn't put `nodrail-policy` on your path: install `@nodrail/policy-engine` too if something on your machine calls it.

To use `nodrail` in the Claude Code hook, write `nodrail policy hook` where the [quickstart](../../policy-engine/docs/getting-started.md#connect-claude-code) writes `nodrail-policy hook`.

## Cloud commands

These work with your Nodrail Cloud workspace and need a personal API token, which starts with `ndp_`. They are part of the [Personal API (preview)](https://nodrail.com/docs/api).

> **Never give a token that can decide or publish to an agent Nodrail governs.** An agent holding a `decide` token could approve its own requests; one holding `rules:write` could rewrite the rules that hold it back. Agents and assistants get `read` tokens.

| Command             | What it does                                                        |
| ------------------- | ------------------------------------------------------------------- |
| `login`             | Saves a personal token; `--token-stdin` to pipe it                  |
| `logout`            | Forgets the saved token                                             |
| `whoami`            | The person, workspace, role and scopes behind the token             |
| `approvals`         | Requests waiting for a person; `--agent <key>`, `--watch`           |
| `approve <id>`      | Approves a request once, after showing it and asking                |
| `reject <id>`       | Rejects a request, after showing it and asking                      |
| `activity`          | Events; `--q`, `--agent`, `--outcome`, `--kind`, `--range`, `--run` |
| `runs`              | Runs; `--q`, `--agent`, `--outcome`, `--range`                      |
| `run <id>`          | One run and its timeline                                            |
| `insights`          | Approval and rule numbers; `--days 7`, `30` or `90`                 |
| `rules pull [file]` | The rules file, to stdout without a file                            |
| `rules push <file>` | Previews, shows the difference, asks and publishes                  |
| `workspace publish [folder]` (preview) | Makes the lock here the revision your team should run, after asking; digests only (`rules:write`) |
| `workspace show [folder]` (preview) | The team's intended revision, next to the lock here and each host |

```sh
nodrail login
nodrail approvals --watch
nodrail approve 6d1c2f0a-…
nodrail activity --outcome denied --range 24h
nodrail rules pull rules.yaml
```

`workspace publish` needs the project's stable `id:` in nodrail.yaml: without it, two projects with the same folder name would share one intended revision, so it stops and suggests one. It sends the id, the project's name (its folder's), the lock's workspace and policy digests, and the lock's file paths with their digests. It never sends a file's contents: git carries those. The **Inventory** page then marks each machine applied from another revision as behind. To have machines report there, see [Observation](playbooks.md#observation-preview).

`<id>` is the UUID that `nodrail approvals` lists, not the `APR-` reference. The token comes from `NODRAIL_TOKEN` when it is set, else from `nodrail login`. Tokens, scopes and what each command sends are described in the [Personal API (preview)](https://nodrail.com/docs/api).

### Options

| Option                 | Meaning                                                             |
| ---------------------- | ------------------------------------------------------------------- |
| `--json`               | Machine-readable output on stdout; notes and questions go to stderr |
| `-e`, `--environment`  | An environment's slug; the workspace's default otherwise            |
| `--url`, `NODRAIL_URL` | Nodrail's address, for self-hosting                                 |
| `-y`, `--yes`          | Don't ask before deciding or publishing                             |
| `--limit`, `--cursor`  | Page size, from 1 to 100, and the next page's cursor                |

Exit codes: `0` done, `1` failed, with the error's code and request ID, `2` the command line was wrong.
