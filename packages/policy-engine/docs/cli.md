# Command line

This page lists every `nodrail-policy` command, its options and its exit codes.

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

`eval`, `check` and `exec` decide with no run history, so a gate that matches always holds, and a budget that covers the call applies its `otherwise`. Use `test` with a `run` to try gates and budgets.

## `hook`

`--unmatched ask` asks a person when no rule covers a call. The default blocks it. `--agent` and `--installation` set who the rules see.

The rule files and folders given to `hook` are protected: a file tool that would write, edit, patch or delete one of them, or a file inside one of the folders, is denied before the rules are read.

With gates or budgets in the rules, the hook also takes `SubagentStart` and `SubagentStop` and keeps a run ledger. See [Runs, gates and budgets](runs.md#claude-code).

## `runs`

`runs` (or `runs list`) lists the runs in the ledger, `runs show <run>` prints one step by step, and `runs report` counts steps, verdicts and held actions per agent. It needs no rules file. It reads the ledger of the repository you are in, or the folder `NODRAIL_LEDGER` names. Runs on a branch are named `<repo>/<branch>`, such as `github.com/acme/app/feature/login`: see [Claude Code](runs.md#claude-code).

## `check` and `exec`

Arguments after `--` are run directly with no shell, so `;` and `|` in them are plain text. Anything other than an allow is blocked, including `require_approval`, because nobody is there to answer.

## `test`

A cases file is a list of a `name`, a `call` and an `expect` of `allow`, `deny`, `require_approval` or `none`. A `call` is `{ command }` or `{ tool, operation, kind, resource, params }`, plus optional `agent` and `installation`. A case can also carry `run`, the history it is decided in, and `step`, the agent taking the action: see [Testing gates](runs.md#testing-gates). A hand-written call has only the params you give it: deny and review rules with conditions on a missing field still match, so give file calls `path` and `path_parts` as the hook would. See [`examples/cases.yaml`](../examples/cases.yaml).
