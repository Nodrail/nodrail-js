# Changelog

## Unreleased

- Extend coverage of unreadable project contracts and refused hand-back receipts.

- Preserve the agent pause reason when a retried action returns redacted digests.

## 0.9.0

Uses `@nodrail/policy-engine` 0.9.0.

- Bind saved credentials to the origin stored alongside them. Keep legacy Cloud credentials at the Cloud origin.

- The Claude Code plugin steps aside only for a verified installed project hook. Standalone connection settings require a complete origin and credential pair.

- Plugin hooks pair runtime credentials with their own origin, carry caller metadata and use the installed engine hook for applied projects.

## 0.8.0

Uses `@nodrail/policy-engine` 0.8.0. 0.7.0 was never published to npm;
0.8.0 includes its changes.

- Add `policyIfChanged(etag?)` for conditional reads of the live policy.
  Existing SDK and standalone plugin authorization endpoints remain available.

## 0.7.0

Uses `@nodrail/policy-engine` 0.7.0. Nothing waits for a person any more:
a call the rules don't allow is denied, with its reason.

### Removed

- Waiting for a person. A call is allowed or denied at once: `authorize()`
  no longer polls, and loses `waitMs`, `pollMs` and `signal`; `createNodrail()`,
  `guard()` and `check()` lose `waitMs`; `NODRAIL_WAIT_SECONDS`,
  `NodrailClient.status()`, `NodrailClient.withdraw()` and
  `WITHDRAW_TIMEOUT_MS` are gone. A hold from an older server
  (`APPROVAL_PENDING`, `UNKNOWN_PERMISSION_BLOCKED`) is a deny with its
  reason.
- `HostDecision.verdict` is `allow` or `deny`; `require_approval` is gone.

### Changed

- The plugin hooks' `PreToolUse` timeout is 30 seconds (it was 360, to wait
  for a person), and the hook denies a call Nodrail hasn't answered in 25.
- The `write-needs-review` example policy is now `write-after-review`: a gate
  that denies issue writes until a reviewer agent has passed the work.

### Added

- `NodrailClient.policy()`: the live policy of the credential's environment
  (`GET /runtime/policy`, scope `policy:read`), with the file it was published
  from and its SHA-256, for a host that decides with its own engine.
- `NodrailClient.decisions(batch)`: records calls the hook decided on its
  host (`POST /runtime/decisions`, scope `decisions:write`) in their runs
  and Activity, at most 100 per call; each item answers its row or why it
  wasn't recorded. Nodrail never decides them again.
- `@nodrail/client/hooks`: `runHook`, the hook the plugins ship, for a
  command line that runs it in-process (`nodrail connect hook`).

## 0.6.0

Uses `@nodrail/policy-engine` 0.6.0.

### Added

- The hook reads `.nodrail/contracts.json`, which `nodrail apply` writes
  with the compiled brief and input contracts, from
  `CLAUDE_PROJECT_DIR` or the nearest folder above the call's `cwd`. A
  dispatch it covers sends its brief's reported fields as `params.brief`,
  an operation it covers sends classified inputs as `[classified]`, and
  an invalid brief or input is denied before Cloud is asked: the SDK's
  `withContractFields`, loaded from its own file
  (`dist/nodrail-hook-contracts.mjs`) only for a covered call, so the hook
  stays under 80 KB with no schema or YAML library. Without the file
  nothing changes. A file that can't be read, or a checker that can't be
  loaded for a covered call, blocks.

- The hook sends a flat `RECEIPT <agent>` header block as the receipt when
  no fenced block ends the message, so Cloud can read it with the agent's
  declared contract.
- A `SubagentHandback` (Claude Code `auto` mode) finishes its step with the
  receipt it carries; when Cloud answers that the receipt is invalid or
  missing, the hand-back is denied with the reason so the subagent resends.
  The call is then decided like any other.
- A call in a run sends the work revision it is about as `run.subject`
  (the git work tree at `cwd`, or the hook event's `cwd`), and again as the
  permit's `subject`, read afresh because the work may change while a person
  decides. Unknown is sent as `null`, never left out or guessed. Options
  `subject` and `cwd` change how it is read.
- `report(decision, outcome, { measured })` and `run(action, perform,
{ measure })` send the amounts a result measured (`result.` paths, whole
  non-negative numbers); any unusable amount leaves all of them out.
- `run(..., { timeoutMs })`: a call not waited for to the end, or one that
  rejects with `AbortError`/`TimeoutError`, is reported `unknown`, not
  `failure`; so is a Claude Code tool call that was interrupted.
- Reports are idempotent: the SDK keys each by its permit, and the client
  retries a network or server error twice with the same key; a key the
  server already has counts as reported.
- `contracts` option and `withContractFields`: given the published brief
  and input contracts, a guarded call is checked against its declared input
  before Cloud is asked (refused as `CONTRACT_REFUSED`, with paths and codes
  only), and Cloud receives each classified argument as `[classified]`; a
  dispatch carries its brief's reported fields as `params.brief`. The Claude
  Code hook doesn't read contracts yet: the hook stays a small bundle with
  no schema or YAML library, and has no source for them.
- Talking to a server from before these fields, the client asks once more
  without `subject` or `measured` when the server refuses them.

### Fixed

- A header block whose title joins the agent without a space
  (`RECEIPT-qa`) is sent as the receipt too.
- An error thrown in a callback no longer ends the hook with exit 1, which
  Claude Code treats as no objection: a tool call is blocked (2), and any
  other event ends with 0 so a subagent can still stop.

## 0.5.2

### Fixed

- With the engine's change, a git that doesn't answer in time blocks the
  call ("git didn't answer within 5 s"), since a budget couldn't count it
  without its run; a step event is left unrecorded.

## 0.5.1

Released with `@nodrail/policy-engine` 0.5.1, which it uses: the hook it
bundles carries that version's two telemetry fixes. Otherwise the client
behaves as in 0.5.0.

## 0.5.0

Released with `@nodrail/policy-engine` 0.5.0, which it uses. The hook it
bundles judges GitHub Copilot CLI's calls (`--host copilot`) and sends
decisions in the reporting contract v2; see the engine's changelog.
Otherwise the client behaves as in 0.4.0.

## 0.4.0

Released with `@nodrail/policy-engine` 0.4.0, which it uses. The hook
describes Codex's agent calls as that version does: starting one
(`collaborationspawn_agent`, `spawn_agent`) is `tool: codex`,
`operation: agent` on its `agent_type`, and the other collaboration calls are
`tool: codex` with their own operation. Before, they read as unknown Claude
Code tools. Otherwise the client and its hook behave as in 0.3.0.

## 0.3.0

Released with `@nodrail/policy-engine` 0.3.0, which it uses; the client and its
hook behave as in 0.2.1. Its dependencies are updated.

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
