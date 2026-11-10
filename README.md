# Nodrail for TypeScript

**Decide what an AI agent may do before it does it.**

Wrap your agent's tools in one line. Before each one runs, Nodrail checks it
against your rules: allow it, deny it, or ask a person. Anything no rule covers
waits until a person allows it, and anything that can't be checked is blocked.

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

You already have an agent with tools. Adding Nodrail is two lines of code and one
environment variable.

1. In Nodrail, open **Agents → Connect an agent**, choose **TypeScript SDK**, and
   copy the credential.
2. Install the package, and put the credential where your other API keys live:
   `.env` in development, your host's secret settings in production.

   ```sh
   npm install @nodrail/client
   ```

   ```sh
   NODRAIL_CREDENTIAL=ndr_...
   ```

3. Wrap the tools you already pass to your agent:

   ```ts
   import { guard } from "@nodrail/client";

   // Before: generateText({ model, tools, prompt })
   const { text } = await generateText({ model, tools: guard(tools), prompt });
   ```

Now, before a tool runs, Nodrail checks it. Allowed calls run as before. Denied
ones don't run, and the agent is told why. Calls no rule covers wait for someone
to allow them in Nodrail. Your rules live in Nodrail and change without a deploy.

There are complete examples for the
[Vercel AI SDK](packages/client/examples/frameworks/vercel-ai-sdk.ts),
[LangChain](packages/client/examples/frameworks/langchain.ts),
[OpenAI Agents](packages/client/examples/frameworks/openai-agents.ts) and
[your own loop](packages/client/examples/frameworks/plain-function.ts). The
[client README](packages/client/README.md) covers the LangChain middleware,
rules that look inside a call, options, block codes and limits. Without an account, try rules
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
