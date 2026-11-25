# Nodrail policy engine

The open engine at the core of [Nodrail](https://nodrail.com), the open control plane for AI agent development. `@nodrail/policy-engine` compiles Nodrail rules files and decides allow or deny for each action an AI agent proposes. The CLI, library and local hook run on the host, with no server or account.

Write and test your first rule with the [policies guide](https://nodrail.com/docs/policies).

## Try a policy locally

Install the engine with Node.js 22 or later.

```sh
npm i -g @nodrail/policy-engine
```

With pnpm, run `pnpm setup` once first, then `pnpm add --global @nodrail/policy-engine`.

[`@nodrail/cli`](https://www.npmjs.com/package/@nodrail/cli) installs `nodrail`, Nodrail's one command line. `nodrail policy validate`, `eval` and every other command here behave exactly as `nodrail-policy` does, and `nodrail add` builds a repository's policy from ready-made modules.

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

Use the [local hook](docs/getting-started.md) with Claude Code or [embed the evaluator](docs/library.md) in a harness you maintain. Map supported tool calls consistently so that the same rule has the same meaning in each integration. Treat anything but an allow as blocked, and hand the reason back to the agent.

Building a compatible evaluator? Start with the [conformance fixtures](tests/fixtures/conformance-v1.json) and the [rules reference](docs/rules.md).

## What it does

- **One format for covered tool calls.** An adapter can describe shell commands, file operations, web requests and MCP tools for evaluation.
- **Rules you can review.** Plain YAML with lists, macros and layered files, in the style of [Falco](https://falco.org/docs/concepts/rules/). Validate them and test expected outcomes in CI.
- **Explicit outcomes.** A rule allows or denies, and deny takes precedence over allow. Gates and budgets deny with a reason until they are met, so the agent fixes things and retries; nothing waits for a person. An unmatched action returns `none`. The local hook blocks it by default.
- **Run history (preview).** Level-3 gates and budgets use recorded steps and actions. Read the [preview reference](docs/runs.md) for the required inputs.
- **Hard to talk around.** `g"i"t  push` is judged as `git push`, and `git status; rm -rf /` doesn't match a rule for `git status`.
- **Secrets stay out.** Likely credentials are removed from how a call is described, so rules and reviewers don't see them.
- **Small.** Three runtime dependencies. The evaluator has no Node APIs, so it can run in other JavaScript runtimes.

## What it doesn't do

It decides; it doesn't enforce. A hook or your own code has to act on the answer, and calls that don't pass through it aren't seen. It isn't a sandbox, and an agent that can change its own hook configuration can remove it. Read the [security model](docs/security-model.md) before relying on it.

## Documentation

| Guide                                                   |                                                        |
| ------------------------------------------------------- | ------------------------------------------------------ |
| [Write and test rules locally](docs/getting-started.md) | Write rules and connect Claude Code                    |
| [Rules](docs/rules.md)                                  | Everything a rule file can contain                     |
| [Runs, gates and budgets (preview)](docs/runs.md)       | Rules about what already happened in a run             |
| [Commands and tools](docs/commands-and-tools.md)        | How each kind of call is described and matched         |
| [CLI reference (nodrail-policy)](docs/cli.md)           | Every `nodrail-policy` command                         |
| [CLI reference (nodrail)](https://nodrail.com/docs/cli) | `nodrail`: projects, plan and apply, the control plane |
| [Integrate your own harness](docs/library.md)           | Use the engine from TypeScript                         |
| [Security model](docs/security-model.md)                | What is and isn't guaranteed                           |

## Nodrail

This engine is the open-source core of [Nodrail](https://nodrail.com). `nodrail apply` installs it as a hook on each agent host (Claude Code, Codex, Copilot), where it decides every call locally. The Nodrail control plane, self-hosted or Nodrail Cloud, adds the published policy, runs, receipts, shared budgets and evidence for a team. You don't need a control plane to use the engine.

For a connected project, `nodrail apply` enrolls the machine and saves its
runtime credential for the project and environment at the selected server.
For a local project, `connect: { decide: local }` uses the repository rules.

The hook validates and canonicalizes the origin before looking up the machine
credential. If the environment's policy moves to a different project, the
hook reports the new owner and denies the call in enforcement mode.

## Contributing

See [CONTRIBUTING.md](https://github.com/Nodrail/nodrail-js/blob/main/CONTRIBUTING.md). Please report vulnerabilities privately, as described in [SECURITY.md](SECURITY.md).

The engine suite runs Windows, macOS and Linux secret-store paths on every
host with injected OS operations, alongside the native tests.

## License

[Apache-2.0](https://github.com/Nodrail/nodrail-js/blob/main/LICENSE)

## Connected hooks

Connected hooks prefer caller metadata supplied by the host, then the configured entry agent. The control plane admits active declared agents for the enrolled project and uses the enrolled host identity for an undeclared caller. When another project takes over the environment, the old project's hook blocks and names the new owner.

A connected hook reads the machine credential that `nodrail apply` stored for its control-plane origin, workspace, environment and project. For an explicit environment credential, set `NODRAIL_URL` to the issuing origin. Each covered call needs a fresh access response, including in watch mode. The hook includes the server’s admission ID in its decision report. The server uses this evidence and the current access epoch to verify the report. Missing or expired evidence leaves reports visible in unverified history. On Windows, run the hook under the same account that enrolled the machine so it can open the DPAPI-protected credential. On publish skew the hook keeps evaluating verified policy from its own lock. Decision reports contain caller and tool metadata, verdict, rule, policy digest and run references. Set `connect.report_arguments: true` to include redacted arguments and explanations.
