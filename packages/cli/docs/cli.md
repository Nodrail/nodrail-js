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
