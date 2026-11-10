# Nodrail Policy Engine

**Decide what an AI agent may do before it does it.**

Rules live in YAML in your repository. Before a shell command, file edit, web request or MCP tool call runs, the engine answers: allow it, deny it, or ask a person. Anything no rule covers is blocked.

It runs on your machine with no server and no account. The same rule always gives the same answer.

```yaml
- rule: Safe git reads
  command: { prefix: git status }
  effect: allow

- rule: A person reviews pushes
  command: { prefix: git push }
  effect: require_approval

- rule: Never force push
  command: { prefix: git push --force }
  effect: deny

- rule: Never read secrets
  tool: files
  operation: file.read
  resource: { kind: file, match: any }
  condition:
    - { field: path_parts, op: contains, value: .env }
  effect: deny
```

## Try it

Needs Node 22 or later.

```sh
npm install --global @nodrail/policy-engine

nodrail-policy init repo-work > rules.yaml
nodrail-policy eval rules.yaml --command "git push --force origin main"
```

```json
{
  "outcome": "deny",
  "matchedRuleId": "never-force-push-args",
  "reason": "explicit_rule",
  "explanation": "Matched never-force-push-args with effect deny."
}
```

To put the rules in front of Claude Code, see [Getting started](docs/getting-started.md).

## What it does

- **One decision for everything an agent does.** Shell commands, file reads and edits, web requests, and MCP tools go through the same rules.
- **Rules you can review.** Plain YAML with lists, macros and layered files, in the style of [Falco](https://falco.org/docs/concepts/rules/). Validate them and test expected outcomes in CI.
- **Blocked by default.** Deny beats review, review beats allow, and no match means no.
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
