# CLI reference (nodrail-policy)

`nodrail policy <command>` from [`@nodrail/cli`](../../cli/docs/cli.md) is the same command, with the same flags, output and exit codes.

Use `nodrail-policy` to validate a file, inspect a decision, test expected outcomes or apply a policy before a command runs.

```text
nodrail-policy <command> <rules file or folder>...
```

Files load in the order given. A folder loads its `.yaml` and `.yml` files by name. Use `nodrail-policy --help` and `nodrail-policy --version`.

| Command                               | What it does                                                | Exit code                                     |
| ------------------------------------- | ----------------------------------------------------------- | --------------------------------------------- |
| `init <pack>`                         | Prints a starter file: `read-only` or `repo-work`           | 0, or 2 for an unknown pack                   |
| `validate <rules>`                    | Reports every problem by file and line                      | 0 valid, 1 invalid                            |
| `compile <rules>`                     | Prints the compiled policy as JSON                          | 0, or 1 if invalid                            |
| `eval <rules>`                        | Evaluates one call and prints the result                    | 0 whatever the outcome                        |
| `test <rules> --cases <file>`         | Checks expected outcomes                                    | 0 all passed, 1 otherwise                     |
| `check <rules> -- <program> [args]`   | Answers whether this may run                                | 0 allowed, 1 otherwise                        |
| `exec <rules> -- <program> [args]`    | Runs it only if allowed                                     | The program's own, 126 blocked, 127 not found |
| `hook <rules>`                        | Claude Code `PreToolUse` hook, reading the event from stdin | 0 answered, 2 if rules can't load             |
| `runs [list \| show <run> \| report]` | What the run ledger recorded. Takes no rules                | 0, 1 for a run that isn't there               |

Usage mistakes exit with 2.

## `eval`

Give a command line, or describe the call:

```sh
nodrail-policy eval rules.yaml --command "git status"

nodrail-policy eval rules.yaml \
  --tool stripe --operation refunds.create \
  --kind invoice --resource INV-1 \
  --params '{"amount": 5000}'
```

`--agent`, `--installation` and `--now` set the caller and the clock for `eval`, `check`, `exec` and `hook`. `test` uses `--now`, and takes the caller from each case.

**Level 3 preview.** A matching gate needs run history. To test a gate or budget with recorded steps, see [Testing gates (preview)](runs.md#testing-gates).

## `hook`

`--unmatched deny` (the default) denies a call no rule covers, and says so; `--unmatched allow` lets it through to the host's own permissions, as an allow does. `--unmatched ask` was removed: nothing waits for a person, so the hook refuses it with exit code 2 and says what to use instead. `--agent` and `--installation` set who the rules see.

`--protect-list <file>` also protects the files and folders the list names, one per line from the project folder (the folder that holds the list's own folder, as in `.nodrail/protected.txt`), the list itself, and `~/.nodrail`, where nodrail stages its writes. Lines starting with `#` are skipped. A list that can't be read blocks every call. `nodrail apply` writes this list for a team's setup. With a list, the hook also denies any shell command that names one of these paths, or a folder in the project that holds one, and any command that runs Nodrail itself by any path or through a package runner, whatever the rules allow. A shell command can write any file it names, so even a read is refused. A word naming the whole project folder, as in `git add .`, doesn't count. The hook also protects all of `.git` and the run ledger this way, reads words as the shell joins quoted pieces, denies a wildcard that could match a protected folder (`.gi?`, `.c*`, or a link to one), a link pointing at or above one, a recursive copy, move or sync into one, or into a folder holding one when it would create or overwrite it (a source with its name, or a contents copy whose source holds it), and an extraction (`tar -x`, `unzip`) into either. A line that makes a link and runs anything after it is judged whole, as `command.compound`. The check reads the command's words as written: a path built from a variable or `$(…)`, or a script or program that writes the file itself, is not recognised, so this is a best-effort guard against naming the setup, not a sandbox.

A shell command that only reads files, or searches a folder, in a shape the hook knows exactly is also judged as that file read or search, and the stricter of the two decisions holds: a deny over an allow. So the file rules decide `cat src/app.ts` as they decide the Read tool, secrets included, and a rule about the command itself keeps its meaning. With `--protect-list`, such a read of the setup's files, such as Codex reading a skill, isn't refused for naming them: it changes nothing, and the file rules decide it. Any other command that names them is. The shapes are `cat`, `head`, `tail` (not `-f`), `nl -ba` and `wc` on one file or several, up to 20, each judged as its own read so one secret among them denies the command; `sed -n '<lines>p'` and `grep` on one file; `ls`; and `rg`, with or without `--files`, with flags that only shape the output and one optional `-g` glob. A path with a wildcard or a leading `~` is left a command, because the shell expands it first; an `rg` pattern or glob may hold wildcards only where it is quoted. `rg --hidden`, `-u`, `--no-ignore` and `grep -r` stay commands too: they read dotfiles such as `.env` without naming them. Codex reads files this way.

`--connect <file>` reads the setup written by `nodrail apply`. Cloud mode
fetches the live policy with the host credential, verifies it against the
lock digest and uses an ETag to revalidate the cached file. During an outage
only a matching, previously verified copy can decide. The host also uses
its credential to read evidence and report decisions. In local mode the
hook evaluates the supplied repository policy. Watch mode records verdicts
and lets the host continue once policy verification succeeds.

`--connections <file>` reads calls to the setup's tool connections as their declarations say. Claude Code and Codex both name a call to an MCP server `mcp__<connection>__<tool>`. For a connection the file declares, the call is tool `<connection>`, operation `<tool>`, and the resource is the one its declaration names, such as `{ kind: collection, from: collection }`: the `collection` argument's value, as a `collection`. A tool the connection doesn't declare, or a call without the argument its resource comes from, is denied with the reason. The agent is the one the host names, never one written in the arguments. A file that can't be read blocks every call. `nodrail apply` writes it as `.nodrail/connections.json`; only its `operations` are read.

`--telemetry <file>` sends each decision as an OpenTelemetry span to the receiver the file names (`nodrail apply` writes it as `.nodrail/telemetry.json`). The hook only adds the span to a bounded queue in `~/.nodrail/telemetry/` and starts a separate sender, so a receiver that is slow or down never delays or changes a decision; a file that can't be read turns telemetry off with a warning, and the hook goes on.

`--host codex` is for Codex, and `--host copilot` for GitHub Copilot, whose calls are read as the Claude Code calls they are. On every host the hook answers the same way: silence lets a call through, and a deny carries its reason.

When Claude Code or Codex says which agent made a call, its subagent's type or the session's `claude --agent`, the rules see that agent instead: the host sets it from the agent definition it started, and the model can't change it. `--agent` then names the entry agent, for calls the host doesn't label. So rules with `agent:` apply per subagent, and a rule on `tool: claude-code`, `operation: agent` decides which agents another may start.

The rule files and folders given to `hook` are protected: a file tool that would write, edit, patch or delete one of them, or a file inside one of the folders, is denied before the rules are read.

**Level 3 preview.** The run-aware Claude Code integration also records subagent starts and finishes. See [Run history in Claude Code (preview)](runs.md#claude-code).

## `runs`

> **Preview command.** `runs` needs version 0.2.0 or later. Check `nodrail-policy --help` for the commands in your installation.

`runs` (or `runs list`) lists the runs in the ledger, `runs show <run>` prints one step by step, and `runs report` counts steps, verdicts and held actions per agent. It needs no rules file. It reads the ledger of the repository you are in, or the folder `NODRAIL_LEDGER` names. Runs on a branch are named `<repo>/<branch>`, such as `github.com/acme/app/feature/login`: see [Claude Code run history (preview)](runs.md#claude-code).

## `check` and `exec`

Arguments after `--` are run directly with no shell, so `;` and `|` in them are plain text. Anything other than an allow is blocked.

## `test`

A cases file is a list of a `name`, a `call` and an `expect` of `allow`, `deny` or `none`. A `call` is `{ command }` or `{ tool, operation, kind, resource, params }`, plus optional `agent` and `installation`. A hand-written call has only the params you give it: deny rules with conditions on a missing field still match, so give file calls `path` and `path_parts` as the hook would. See [`examples/cases.yaml`](../examples/cases.yaml).

**Level 3 preview.** Run-history test cases can also supply `run` and `step`. `run` is the history a case is decided in, and `step` is the agent taking the action: see [Testing gates (preview)](runs.md#testing-gates).
