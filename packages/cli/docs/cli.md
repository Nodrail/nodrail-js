# CLI reference (nodrail)

`nodrail` is Nodrail's one command line. It has three parts:

- **Project commands**, offline: `nodrail add`, `nodrail policy lock` and `nodrail policy export --frozen` manage a repository's policy from catalog modules and your own files. See [Playbooks](playbooks.md).
- **Policy commands**, offline: `nodrail policy init`, `validate`, `compile`, `eval`, `test`, `check`, `exec`, `hook` and `runs` check and apply a rules file on your machine.
- **Cloud commands**, with a personal token: `login`, `approvals`, `approve`, `reject`, `activity`, `runs`, `run`, `insights` and `rules pull` or `rules push` work with your Nodrail Cloud workspace.

The project and policy commands need no account and send nothing anywhere.

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
| `plan` (preview)                  | Shows what `nodrail apply` would set up for the team           | 0 could apply, 1 something blocks it        |
| `apply` (preview)                 | Sets the team up on its host, after showing the plan           | 0 done or nothing to do, 1 refused          |

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

### `plan` (preview)

```sh
nodrail plan
nodrail plan --json
```

`plan` reads the [team's resources](playbooks.md#give-the-roles-to-your-agents-preview) and shows what `nodrail apply` would set up for the host `runtime` names. It only reads: it writes no file and installs nothing. For `runtime: claude-code` it plans:

| File | What it holds |
| --- | --- |
| `.claude/agents/<name>.md` | Each team member: its description, model, skills to preload, and its instructions as the body |
| `.claude/skills/<skill>/` | Each member's skill folders, copied |
| `.nodrail/effective.apf.yaml` | The locked policy, exactly what `policy export --frozen` prints |
| `.claude/settings.json` | `"agent"` set to the team's entry agent, and a `PreToolUse` hook running `nodrail policy hook` on that policy with `onFailure: "block"`. Other settings and hooks stay as they are. |

Each file is marked `+` to create, `~` to update, `-` to remove, `=` unchanged, or `!` when apply would refuse. A file that already holds exactly what nodrail would write is `=` and stays yours: nodrail never removes it later. Settings behind a link, or with `disableAllHooks` on, are `!`. apply updates or removes only files it wrote, as recorded in `.nodrail/setup-state.json`, and only while they still hold what it wrote. A file already there that nodrail didn't write, one edited since, a path through a link, and an `"agent"` setting someone else chose are all `!`.

It also checks that the policy matches the lock, that `claude` 2.1.295 or later and `nodrail` are on `PATH` (the hook runs `nodrail`; with `onFailure: "block"`, a missing one blocks every tool call), and that skills hold no links. `plan` exits with 1 when anything is marked `!`.

For `runtime: codex` it plans:

| File | What it holds |
| --- | --- |
| `.codex/config.toml` | The entry agent's instructions as `developer_instructions`, and its model. The session you start is the entry agent. |
| `.codex/agents/<name>.toml` | Each other member: name, description, instructions and model |
| `.agents/skills/<skill>/` | Each member's skill folders, copied |
| `.codex/hooks.json` | A `PreToolUse` hook running `nodrail policy hook` on the policy |
| `.nodrail/effective.apf.yaml` | The locked policy, as for Claude Code |

nodrail owns these files whole: one that is already there and wasn't written by nodrail is `!`. A rule that needs a person's review is a deny on Codex, because Codex can't ask: the hook runs with `--host codex`. It checks for `codex` 0.169.0 or later.

Codex runs a project's config and hooks only after you trust them, and nodrail never does that for you. Until you have, Codex runs your agents without the policy. Once `apply` has written the files:

1. Open `codex` in the folder and trust it.
2. Run `/hooks` in Codex and trust nodrail's hook.

`plan` and `apply` ask Codex whether it runs nodrail's hook here, through `codex app-server`, without changing anything. Until it does, `plan` says which step is missing and `apply` exits with 1 after writing the files. The hook names the policy by its full path, because Codex runs hooks in the folder you started it in; after moving the project, run `apply` again and trust the hook again. When Codex can't run `nodrail` at all, the hook answers with a deny, so Codex blocks the call rather than letting it through. Codex reads files through its shell (`cat`, `sed -n`, `rg`): the hook judges those as the file reads they are, so a policy that allows reading files lets Codex read them, and the same secret rules hold. Codex on Windows isn't set up yet.

### `apply` (preview)

```sh
nodrail apply
nodrail apply --yes
```

`apply` shows the same plan, asks before changing anything, and makes exactly those changes. It refuses while anything is marked `!`, and changes nothing then. Without a terminal it needs `--yes`, which you give once you have read `nodrail plan`; `--json` needs `--yes` too.

It runs as the project's only writer, like `add` and `lock`: a second `nodrail` waits its turn and names the one at work. Inside, it plans again, and if anything differs from what you were shown, it stops without changing anything. Every change is staged first in a journal in your home folder, then made one file at a time, with `.nodrail/setup-state.json` last. If it stops partway, the next `nodrail apply` or `nodrail policy lock` finishes it. A file someone changes while it runs is left alone and named.

Run it again after changing a resource, a skill or a binding, and lock the policy first: it updates only the files that changed and removes the ones no longer needed, such as a member who left the team. With nothing to change it writes nothing.

With `start: true` in `nodrail.yaml` and a terminal, it then opens the host. Otherwise run `claude` or `codex` in the folder: it starts as the entry agent, behind the policy hook. For Codex, `apply` is done only once Codex runs nodrail's hook; see above.

A session that is already open keeps the agent files, skills and settings it started with, and `apply` says when it changed any: start a new session to use them. The policy is different: the hook reads it at every tool call, so a policy change applies to open sessions from their next call.

To go back to an earlier setup, put back the resources, skills and policy files as they were, for example with `git checkout <commit> -- nodrail.yaml nodrail.lock.yaml resources skills policies`, then run `nodrail apply`. The setup is made from those files alone, so `apply` writes the earlier files back exactly. Files that were yours before nodrail never changed, so there is nothing of yours to restore.

The policy has to cover every call your agents make, including the ones your own instructions ask for. If your user-wide instructions, such as `~/.codex/AGENTS.md` or `~/.claude/CLAUDE.md`, have agents run a command at the start, that command is blocked like any other until a rule allows it.


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

```sh
nodrail login
nodrail approvals --watch
nodrail approve 6d1c2f0a-…
nodrail activity --outcome denied --range 24h
nodrail rules pull rules.yaml
```

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
