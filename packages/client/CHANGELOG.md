# Changelog

## 0.2.1

Package metadata and documentation only; the client and its hook behave
as in 0.2.0.

- npm description: "TypeScript client for Nodrail Cloud. Check supported tool
  calls against workspace policies and coordinate human approvals." Keywords
  add `tool-permissions`.
- The run-history walkthrough is marked as preview and names the client
  release that has `inRun` and `step`.

## 0.2.0

Runs and steps for any agent framework, so gates and budgets work outside
Claude Code.

### Breaking

- Starting a subagent in Claude Code (`Agent`, and `Task`, its earlier name)
  is now governed, as tool `claude-code`, operation `agent`, resource type
  `agent` with the subagent's type as id. Without a rule that allows it, each
  start waits for a person. Upgrading: add a rule that allows `claude-code`
  `agent` for the subagent types you use. Rule files with a rule for the
  earlier resource (type `tool`, id `Agent`) no longer compile.
- The Claude Code hook's run key is `NODRAIL_RUN`, else `<repo>/<branch>`
  pinned to the session by its first event, so switching branch doesn't
  change the run. On the default branch, a detached HEAD or outside git it is
  `session:<id>`. The repository is the `origin` remote as host/owner/name,
  with no credentials. Pins are kept in `.git/nodrail/sessions`.

### Added

- A block says why when Cloud does: a gate tells the agent to run the steps
  it waits for (such as QA or review) after the last change and try again; a
  used-up budget and a paused agent are named too.
- `createNodrail({ run })`, or `NODRAIL_RUN`, sets the run calls belong to;
  `nodrail.inRun(key, work)` sets it for one piece of work.
- `nodrail.step(agent, work)` records a step around an agent's work. Calls
  made while it runs belong to it, through a framework's tool loop too, and
  the verdict is read from the result with `receiptOf`, or by your own
  function passed as `{ receipt }`.
- `authorize()` takes `run: { key, step? }` and sends it with the intent, so
  the server can decide gates and budgets on the run's history. The run is not
  part of the descriptor digest. `client.step()` records a step starting or
  finishing.
- The Claude Code hook sends each intent's run and step, and records
  `SubagentStart` and `SubagentStop` as steps with the receipt block. Recording
  a step never blocks the agent.
- The Codex hook sends the run with each call. Codex doesn't say which
  subagent makes a call, so every call is the main agent's.
- A call that stops waiting for a person withdraws its request, so it leaves
  Approvals instead of waiting there for someone to approve a call that will
  never run. `authorize()` does it when `waitMs` passes or its new `signal`
  aborts, and the Claude Code and Codex hooks at their own deadline too. It is
  best effort and takes at most 3 seconds; the call is blocked either way.
  With `waitMs: 0` the request stays open, to be decided later.
  `client.withdraw(actionId)` sends it by hand; it never allows anything.

### Changed

- Receipts are read from the last 16 KB of a message only, and a block over
  8 KB is no receipt, in the hook and in `receiptOf` alike, as in Cloud.

## 0.1.5

- New: `guardMcpServer(server)`. Every tool the server registers from then on
  is checked under the name it registers with, so a tool can't be guarded
  under the wrong name. Guarding a server that already has tools throws.
- A later `tool.update({ callback })` on a guarded MCP tool is checked too;
  before, it removed the check.
- Tests now fail if coverage drops.

## 0.1.4

- Claude Code's reads (Read, Grep, Glob) are checked on the machine: one that
  reaches a place credentials live is blocked. Reads still aren't sent to
  Nodrail.
- The fixes in `@nodrail/policy-engine` 0.1.4.

## 0.1.3

Fixes from a second independent review.

- MCP SDK tools are now really checked. The server keeps calling the object
  `registerTool` returns, so `guard` now puts the check inside that object and
  returns it; before, it returned a copy the server never used. Tested against
  the real MCP SDK client and server.
- A tool with two ways to run, such as `execute` and `run`, is refused instead
  of having only one checked. MCP task tools are refused until supported.
- The fixes in `@nodrail/policy-engine` 0.1.3.

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
