# Agent Policy Format for AI agent permissions

Write agent permissions in YAML, test the decisions locally and enforce them at the tool call. Nodrail maintains the open-source APF engine and a separate TypeScript client for teams using Nodrail Cloud.

[![CI](https://github.com/Nodrail/nodrail-js/actions/workflows/ci.yml/badge.svg)](https://github.com/Nodrail/nodrail-js/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/Nodrail/nodrail-js/badge)](https://scorecard.dev/viewer/?uri=github.com/Nodrail/nodrail-js)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

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

## Use the same policy in your harness

The Claude Code local hook reads your rules before covered tools run. You can also compile the file in your own harness, map proposed calls to action descriptors and invoke the tool only after a matching allow. Portability depends on the actions and facts the integration supplies.

- [Connect the local Claude Code hook](packages/policy-engine/docs/getting-started.md).
- [Embed the evaluator](packages/policy-engine/docs/library.md) or use the [published test cases](packages/policy-engine/tests/fixtures/conformance-v1.json) when building a compatible evaluator.
- [Check integration coverage](https://nodrail.com/integrations), including the Cloud-connected Codex plugin.

## Packages

| Package                                            | When to use it                                                                                                  |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| [`@nodrail/policy-engine`](packages/policy-engine) | Compile and evaluate APF locally, test rules in CI or integrate a local enforcement point. No account required. |
| [`@nodrail/client`](packages/client)               | Check wrapped tools against workspace policies and coordinate human approvals in Nodrail Cloud.                 |

## Connect a team workspace

Create a Nodrail credential in **Agents → Connect an agent**. Configure it on the server where the tools run. Pass the guarded tools to your agent.

```ts
import { guard } from "@nodrail/client";

const agent = createAgent({ model, tools: guard(tools) });
```

This excerpt assumes your framework already supplies `createAgent`, `model` and `tools`. Read the [client quickstart](packages/client/README.md) for installation, credentials and supported tool shapes. For an existing coding agent, see the [Claude Code and Codex plugins](https://github.com/Nodrail/agent-plugins).

## Enforcement and failure behavior

The engine returns a decision. The harness controls execution. Code with a direct route to a tool can bypass the check. The Cloud client blocks a wrapped call when authorization fails or times out. Each plugin documents the behavior of its runtime when the hook itself cannot start. [Security model](packages/policy-engine/docs/security-model.md).

## Status

Developer preview. The API may change before 1.0, following semantic versioning
and the [changelogs](packages/client/CHANGELOG.md).

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md). Please report vulnerabilities privately,
as [SECURITY.md](SECURITY.md) describes.

## License

[Apache-2.0](LICENSE)
