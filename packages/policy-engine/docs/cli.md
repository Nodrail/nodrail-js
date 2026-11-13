# Command line

Use `nodrail-policy` to validate a file, inspect a decision, test expected outcomes or apply a policy before a command runs.

```text
nodrail-policy <command> <rules file or folder>...
```

Files load in the order given. A folder loads its `.yaml` and `.yml` files by name. Use `nodrail-policy --help` and `nodrail-policy --version`.

| Command                             | What it does                                                | Exit code                                     |
| ----------------------------------- | ----------------------------------------------------------- | --------------------------------------------- |
| `init <pack>`                       | Prints a starter file: `read-only` or `repo-work`           | 0, or 2 for an unknown pack                   |
| `validate <rules>`                  | Reports every problem by file and line                      | 0 valid, 1 invalid                            |
| `compile <rules>`                   | Prints the compiled policy as JSON                          | 0, or 1 if invalid                            |
| `eval <rules>`                      | Evaluates one call and prints the result                    | 0 whatever the outcome                        |
| `test <rules> --cases <file>`       | Checks expected outcomes                                    | 0 all passed, 1 otherwise                     |
| `check <rules> -- <program> [args]` | Answers whether this may run                                | 0 allowed, 1 otherwise                        |
| `exec <rules> -- <program> [args]`  | Runs it only if allowed                                     | The program's own, 126 blocked, 127 not found |
| `hook <rules>`                      | Claude Code `PreToolUse` hook, reading the event from stdin | 0 answered, 2 if rules can't load             |

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

`--unmatched ask` asks a person when no rule covers a call. The default blocks it. `--agent` and `--installation` set who the rules see.

The rule files and folders given to `hook` are protected: a file tool that would write, edit, patch or delete one of them, or a file inside one of the folders, is denied before the rules are read.

**Level 3 preview.** The run-aware Claude Code integration also records subagent starts and finishes. See [Run history in Claude Code (preview)](runs.md#claude-code).

## `runs`

> **Preview command.** This section describes a CLI with run-history support. Version 0.1.5 has no `runs` command. Check `nodrail-policy --help` for the commands in your installation.

`runs` (or `runs list`) lists the runs in the ledger, `runs show <run>` prints one step by step, and `runs report` counts steps, verdicts and held actions per agent. It needs no rules file. It reads the ledger of the repository you are in, or the folder `NODRAIL_LEDGER` names. Runs on a branch are named `<repo>/<branch>`, such as `github.com/acme/app/feature/login`: see [Claude Code run history (preview)](runs.md#claude-code).

## `check` and `exec`

Arguments after `--` are run directly with no shell, so `;` and `|` in them are plain text. Anything other than an allow is blocked, including `require_approval`, because nobody is there to answer.

## `test`

A cases file is a list of a `name`, a `call` and an `expect` of `allow`, `deny`, `require_approval` or `none`. A `call` is `{ command }` or `{ tool, operation, kind, resource, params }`, plus optional `agent` and `installation`. A hand-written call has only the params you give it: deny and review rules with conditions on a missing field still match, so give file calls `path` and `path_parts` as the hook would. See [`examples/cases.yaml`](../examples/cases.yaml).

**Level 3 preview.** Run-history test cases can also supply `run` and `step`. `run` is the history a case is decided in, and `step` is the agent taking the action: see [Testing gates (preview)](runs.md#testing-gates).
