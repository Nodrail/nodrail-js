# Command line

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

`--agent`, `--installation` and `--now` set the caller and the clock, and also work with `check`, `exec` and `test` where they apply.

## `hook`

`--unmatched ask` asks a person when no rule covers a call. The default blocks it. `--agent` and `--installation` set who the rules see.

## `check` and `exec`

Arguments after `--` are run directly with no shell, so `;` and `|` in them are plain text. Anything other than an allow is blocked, including `require_approval`, because nobody is there to answer.

## `test`

A cases file is a list of a `name`, a `call` and an `expect` of `allow`, `deny`, `require_approval` or `none`. A `call` is `{ command }` or `{ tool, operation, kind, resource, params }`. See [`examples/cases.yaml`](../examples/cases.yaml).
