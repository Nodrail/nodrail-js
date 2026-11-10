# Nodrail for TypeScript

**Decide what an AI agent may do before it does it.**

Wrap your agent's tools in one line. Before each one runs, Nodrail checks it
against your rules: allow it, deny it, or ask a person. Anything no rule covers
is blocked, and so is anything that can't be checked.

```ts
import { guard } from "@nodrail/client";

const agent = createAgent({ model, tools: guard(tools) });
```

It works with LangChain, the Vercel AI SDK, the OpenAI Agents SDK and any agent
whose tools are functions. Using Claude Code or Codex? Install the
[plugin](https://github.com/Nodrail/agent-plugins) instead: no code at all.

[![CI](https://github.com/Nodrail/nodrail-js/actions/workflows/ci.yml/badge.svg)](https://github.com/Nodrail/nodrail-js/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/Nodrail/nodrail-js/badge)](https://scorecard.dev/viewer/?uri=github.com/Nodrail/nodrail-js)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

## Packages

| Package                                              | What it does                                                                                        |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| [`@nodrail/client`](packages/client)                 | The SDK: `guard()` for any framework, a LangChain middleware, and the hook for Claude Code and Codex |
| [`@nodrail/policy-engine`](packages/policy-engine)   | The open evaluator: rules in YAML, a command line, and simulation with no server or account          |

The policy engine is useful on its own. The client connects an agent to a
[Nodrail](https://nodrail.com) workspace, where people review requests, rules are
shared across a team and every decision is recorded.

## Quick start

1. In Nodrail, open **Agents → Connect an agent**, choose **TypeScript SDK**, and
   copy the credential.
2. Install and wrap:

   ```sh
   npm install @nodrail/client
   export NODRAIL_CREDENTIAL="<the credential>"
   ```

   ```ts
   import { guard } from "@nodrail/client";

   const tools = guard({ createIssue, deleteRepo });
   ```

3. Add a rule under **Policies**, or let the first call wait for a person.

The [client README](packages/client/README.md) covers the LangChain middleware,
rules that look inside a call, options and limits. Without an account, try rules
locally with the [policy engine](packages/policy-engine/README.md).

## How it fails

Every path that can't reach a decision blocks: no credential, Nodrail
unreachable, a refused credential, a timeout, or an answer the client doesn't
understand. A blocked tool isn't called, and the agent reads why as the tool's
result.

This is a control for agents, not a sandbox. Code that doesn't go through
`guard`, or a process outside the agent, isn't checked. The
[security model](packages/policy-engine/docs/security-model.md) says exactly what
is and isn't guaranteed.

## Status

Developer preview. The API may change before 1.0, following semantic versioning
and the [changelogs](packages/client/CHANGELOG.md).

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md). Please report vulnerabilities privately,
as [SECURITY.md](SECURITY.md) describes.

## License

[Apache-2.0](LICENSE)
