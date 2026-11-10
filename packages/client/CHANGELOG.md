# Changelog

## 0.1.2

Security fixes found by an independent review. Upgrade.

- `guard()` no longer leaves a tool unchecked because of its shape. A provider
  tool that still runs locally, an MCP SDK registered tool (`callback`), or a
  tool that runs through `run()` passed through untouched in 0.1.0 and 0.1.1.
  Anything with code of its own is now checked, or refused with an error if its
  shape isn't recognised. A tool can no longer mark itself as already checked.
- The credential is never sent over plain `http`, except to this machine. Other
  addresses block with `INSECURE_URL`.
- Redaction fixes from `@nodrail/policy-engine` 0.1.2.
- A credential loaded after the tools were wrapped is picked up.
- MCP SDK registered tools are supported.
- Types now work with `moduleResolution: nodenext`.

## 0.1.1

The first version published from GitHub Actions, with npm provenance: each
release can be traced to the commit and workflow that built it. No code changes.

## 0.1.0

First public version:

- `guard()` for LangChain, the Vercel AI SDK, the OpenAI Agents SDK, Mastra,
  LlamaIndex, the Anthropic SDK tool runner, the Claude Agent SDK, OpenAI SDK
  `runTools`, and any function.
- `nodrailMiddleware()` for LangChain agents (`@nodrail/client/langchain`).
- `createNodrail()` with `run()`, `check()` and `report()`, and the low-level
  `NodrailClient`.
- The one-file hook for Claude Code and Codex, and their hook settings
  (`@nodrail/client/setup`).
