# Agent Policy Format (APF) policy engine

Use `@nodrail/policy-engine` to compile YAML policies and evaluate the actions an AI agent proposes. The CLI, library and local Claude Code hook run without a server or account.

Write and test your first tool permission rule with the [Agent Policy Format guide](https://nodrail.com/docs/apf).

## Try a policy locally

Install the engine with Node.js 22 or later.

```sh
pnpm add --global @nodrail/policy-engine
```

In an empty directory, save this as `rules.yaml`.

```yaml
- required_engine_version: 2
- rule: Inspect the working tree
  command: git status
  effect: allow
- rule: Protect untracked files
  command: git clean -fd
  effect: deny
```

```sh
nodrail-policy validate rules.yaml
nodrail-policy eval rules.yaml --command "git status"
nodrail-policy eval rules.yaml --command "git clean -fd"
```

The two evaluations print `allow` and `deny`. Both commands inside the quotes are input to the evaluator. Neither runs. Read `outcome` to inspect a decision. For a script that uses an exit code to gate a command, use `nodrail-policy check`.

## Put the decision before the tool

Use the [local hook](docs/getting-started.md) with Claude Code or [embed the evaluator](docs/library.md) in a harness you maintain. Map supported tool calls consistently so that the same APF rule has the same meaning in each integration. If a rule requires review, the harness needs an authorized review path. Otherwise, hold the action.

Building a compatible evaluator? Start with the [conformance fixtures](tests/fixtures/conformance-v1.json) and the [rules reference](docs/rules.md).

## What it does

- **One format for covered tool calls.** An adapter can describe shell commands, file operations, web requests and MCP tools for evaluation.
- **Rules you can review.** Plain YAML with lists, macros and layered files, in the style of [Falco](https://falco.org/docs/concepts/rules/). Validate them and test expected outcomes in CI.
- **Explicit outcomes.** Deny takes precedence over review, and review over allow. An unmatched action returns `none`. The local hook blocks it by default.
- **Run history (preview).** Level-3 gates and budgets use recorded steps and actions. Read the [preview reference](docs/runs.md) for the required inputs.
- **Hard to talk around.** `g"i"t  push` is judged as `git push`, and `git status; rm -rf /` doesn't match a rule for `git status`.
- **Secrets stay out.** Likely credentials are removed from how a call is described, so rules and reviewers don't see them.
- **Small.** Three runtime dependencies. The evaluator has no Node APIs, so it can run in other JavaScript runtimes.

## What it doesn't do

It decides; it doesn't enforce. A hook or your own code has to act on the answer, and calls that don't pass through it aren't seen. It isn't a sandbox, and an agent that can change its own hook configuration can remove it. Read the [security model](docs/security-model.md) before relying on it.

## Documentation

| Guide                                            |                                                |
| ------------------------------------------------ | ---------------------------------------------- |
| [Getting started](docs/getting-started.md)       | Write rules and connect Claude Code            |
| [Rules](docs/rules.md)                           | Everything a rule file can contain             |
| [Runs, gates and budgets (preview)](docs/runs.md)          | Rules about what already happened in a run     |
| [Commands and tools](docs/commands-and-tools.md) | How each kind of call is described and matched |
| [Command line](docs/cli.md)                      | Every `nodrail-policy` command                 |
| [Library](docs/library.md)                       | Use the engine from TypeScript                 |
| [Security model](docs/security-model.md)         | What is and isn't guaranteed                   |

## Nodrail

This engine is the open-source core of [Nodrail](https://nodrail.com), which adds shared approvals, an audit trail and team management for a hosted workspace. You don't need Nodrail to use the engine.

## Contributing

See [CONTRIBUTING.md](https://github.com/Nodrail/nodrail-js/blob/main/CONTRIBUTING.md). Please report vulnerabilities privately, as described in [SECURITY.md](SECURITY.md).

## License

[Apache-2.0](https://github.com/Nodrail/nodrail-js/blob/main/LICENSE)
