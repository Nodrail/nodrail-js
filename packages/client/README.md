# @nodrail/client

Checks with Nodrail before an agent runs a governed action. Anything other than a
fresh, exact allow blocks the call. A timeout, an error or an unknown answer all
mean the action does not run.

**Developer preview:** the API may still change before 1.0. Licensed under
[Apache-2.0](https://github.com/Nodrail/nodrail-js/blob/main/LICENSE). Report
vulnerabilities privately, as described in [SECURITY.md](SECURITY.md).

## Quick start

You already have an agent with tools. Adding Nodrail is two lines of code and one
environment variable; the tools, the agent and the framework stay as they are.

### 1. Get a credential

In Nodrail, open **Agents → Connect an agent**, choose **TypeScript SDK**, and
copy the credential. It is shown once. Each agent gets its own, so a support bot
and a coding bot can follow different rules.

### 2. Install and configure

```sh
npm install @nodrail/client
```

Keep the credential where your other API keys live: your `.env` file in
development, and your host's secret settings in production (Vercel, Railway, AWS
Secrets Manager, a Kubernetes secret, a CI secret).

```sh
NODRAIL_CREDENTIAL=ndr_...
```

### 3. Wrap the tools you already pass to your agent

Before:

```ts
const { text } = await generateText({ model, tools, prompt });
```

After:

```ts
import { guard } from "@nodrail/client";

const { text } = await generateText({ model, tools: guard(tools), prompt });
```

That's the whole integration. Full examples, each checked by the type checker on
every change:

| Framework | Example | Pass to `guard` |
| --- | --- | --- |
| Vercel AI SDK | [`vercel-ai-sdk.ts`](examples/frameworks/vercel-ai-sdk.ts) | your `tools` record |
| LangChain, LangGraph | [`langchain.ts`](examples/frameworks/langchain.ts) | your `tools` array, or use the [middleware](#langchain-middleware) |
| OpenAI Agents SDK | [`openai-agents.ts`](examples/frameworks/openai-agents.ts) | your `tools` array |
| Your own loop | [`plain-function.ts`](examples/frameworks/plain-function.ts) | the functions that do the work |
| Mastra | | a tool or record of tools |
| LlamaIndex | | a tool or array of tools |
| Anthropic SDK tool runner | | your `tools` array |
| Claude Agent SDK | | the tools from `tool()` |
| MCP SDK | [`mcp-server.ts`](examples/frameworks/mcp-server.ts) | what `registerTool` returns, [see below](#mcp-servers) |
| OpenAI SDK `runTools` | | your `tools` array |

A framework's tools keep their exact type, so the result goes wherever the
original went. A plain function now returns a promise, since it asks first. If
`guard` doesn't recognise something it throws straight away, so a tool can never
end up looking protected when it isn't.

### What happens when the agent calls a tool

Before the tool's code runs, the client asks Nodrail whether this agent may make
this call with these arguments. Your team's rules in Nodrail decide:

- **Allowed:** the tool runs as before.
- **Denied:** the tool doesn't run. The agent gets the reason as the tool's
  result, so it can tell the user or try something else.
- **Needs a person:** someone gets the request in Nodrail and allows or denies
  it. The call waits up to 5 minutes for the answer, then counts as blocked.

Every decision is recorded. Rules change in Nodrail, without a deploy.

### Try all three

Ask your agent to use a tool with no rule yet: the call waits, and the request
appears in Nodrail under **Approvals**. Allow it there and the tool runs. Then,
under **Policies**, add a rule that allows or denies that tool, and call it again.

### In development and tests

Without a credential nothing throws: every guarded call is blocked and says the
credential is missing. Set `NODRAIL_WAIT_SECONDS=0` to block at once instead of
waiting for a person. In unit tests of the tools themselves, test the unwrapped
tools.

### LangChain middleware

To cover every tool in a `createAgent` agent, including ones added while it runs:

```ts
import { nodrailMiddleware } from "@nodrail/client/langchain";

const agent = createAgent({ model, tools, middleware: [nodrailMiddleware()] });
```

Use this or `guard`. Using both still asks only once.

### Rules that look inside a call

By default a tool is ruled by its name: tool `send_email`, operation `call`,
resource type `tool` with the name as its id. A name that isn't already
lowercase letters, digits, `_` or `-` gets a short fingerprint (`createIssue`
becomes `createissue-1a2b3c4d`), so prefer snake_case names, or describe the call
yourself.

Rules see the tool's arguments under `input`, so a condition reads
`{ field: input.amount, op: lte, value: 50 }`. Arguments whose names look secret
arrive as `[redacted]`, and inputs over 16 KB arrive only as a fingerprint, so
conditions can't see them.

To write rules about what a tool acts on, say so once:

```ts
guard(tools, {
  describe: {
    create_issue: (input) => ({
      tool: "github",
      operation: "issues.create",
      resource: { kind: "repository", id: (input as { repo: string }).repo },
    }),
  },
});
```

### MCP servers

Pass what `registerTool` returns, keyed by the tool's name. The server keeps
calling that object, so `guard` puts the check inside it, through the SDK's own
`update()`, and gives back the same object:

```ts
const server = new McpServer({ name: "github", version: "1.0.0" });

guard({
  delete_repo: server.registerTool(
    "delete_repo",
    { inputSchema: { repo: z.string() } },
    async ({ repo }) => deleteRepo(repo),
  ),
});
```

A blocked call answers the MCP client with `isError: true` and the reason.
Tested against the real `@modelcontextprotocol/sdk` client and server.

### Options

| Option      | Default                 | Meaning                                                   |
| ----------- | ----------------------- | --------------------------------------------------------- |
| `waitMs`    | `NODRAIL_WAIT_SECONDS`, or 5 minutes | How long a call waits for a person. `0` blocks at once. |
| `onBlocked` | `"return"`              | `"throw"`, or a function, to change what a blocked tool does. Not used by the LangChain middleware, which always answers with an error message to the model. |
| `describe`  | the tool's name         | What rules see for each tool. `guard` only.               |
| `name`      | the function's name     | Needed for a function with no name. `guard` only.         |

`waitMs` and `onBlocked` also go to `createNodrail()`, which makes an instance
with its own `url`, `credential` and `adapterVersion`. Each request to Nodrail
times out after 10 seconds, and a call that waits for a person holds the agent
until the answer or `waitMs`: keep that in mind in serverless functions with a
short time limit.

### Without a framework

```ts
import { createNodrail } from "@nodrail/client";

const nodrail = createNodrail();

// Runs only if allowed. Anything else throws NodrailBlockedError.
await nodrail.run(
  {
    tool: "github",
    operation: "issues.create",
    resource: { kind: "repository", id: "acme/support" },
  },
  () => createIssue(),
);

// Or ask, act on the answer yourself, and say how it went.
const decision = await nodrail.check({ tool: "github", operation: "issues.delete" });
if (decision.allowed) {
  await deleteIssue();
  await nodrail.report(decision, "success");
}
```

A plain string `resource` is resource type `resource`. `run()` and `check()` send
`params` exactly as you pass them, with no redaction: keep secrets out of them.

### Where the connection comes from

Nearest first: options you pass, then `NODRAIL_URL` and `NODRAIL_CREDENTIAL`,
then the file `credential` in `NODRAIL_HOME` (by default `~/.nodrail`). The URL
defaults to `https://app.nodrail.com`. Only the credential is required. The
address must use `https`; plain `http` is accepted only for this machine
(`localhost`, `127.0.0.1`, `::1`), so the credential is never sent in the clear.

With no credential nothing throws at startup: each guarded call is blocked and
says what is missing, and the next call looks again. So an application that loads
its secrets after importing its tools is checked as soon as they are there.

### When a call is blocked

The agent reads a sentence saying why, and `NodrailBlockedError.code` (or
`decision.code`) says the same for your code:

| Code | What it means | What to do |
| --- | --- | --- |
| `APPROVAL_PENDING`, `UNKNOWN_PERMISSION_BLOCKED` | Waiting for a person | Allow it in Nodrail under **Approvals**, then try again |
| `DENIED` | A rule or a person said no | Change the rule, if it should be allowed |
| `EXPIRED`, `INVALIDATED` | The request timed out, or something changed | Try again for a new decision |
| `NOT_CONFIGURED` | No credential found | Set `NODRAIL_CREDENTIAL` |
| `UNAUTHENTICATED` | The credential was refused | Check it, and that `NODRAIL_URL` points at your Nodrail |
| `RATE_LIMITED`, `QUOTA_EXCEEDED` | Too many calls, or the month's allowance is used | Wait, or raise the plan |
| `UNAVAILABLE` | Nodrail couldn't be reached | Check the network; nothing ran |
| `INSECURE_URL` | `NODRAIL_URL` is plain `http` to another machine, so the credential wasn't sent | Use `https`. Plain `http` works only for `localhost` |
| `INVALID_ACTION` | The call couldn't be described, for example a circular input | Pass plain JSON arguments |

### What guard can't cover

- Tools that run on a provider's servers, such as hosted web search, have no
  function here to check. `guard` leaves only these as they are: anything with
  code of its own (`execute`, `handler`, `invoke`, `run`, `call`, `callback`,
  `func`…) is wrapped, or refused with an error if its shape isn't recognised.
  A tool with two ways to run, such as both `execute` and `run`, is refused
  rather than half checked, and so is an MCP task tool.
- MCP servers attached directly to an agent aren't wrapped. Use the tools from
  your MCP client, or the LangChain middleware.
- Tools that never pass through `guard`, and code outside the agent.

## Claude Code and Codex

Install the plugin instead: see
[Nodrail/agent-plugins](https://github.com/Nodrail/agent-plugins). No code changes, and the
checks cover the shell, file edits and MCP tools.

The one-file hook is also here, for setting up by hand: `dist/nodrail-hook.mjs`
(also installed as the command `nodrail-claude-hook`), with the argument `codex`
for Codex. `@nodrail/client/setup` exports the hook settings for both agents
(`claudeCodeHooks`, `codexHooks`). The connect page in Nodrail shows them filled
in.

To see all three outcomes, add these rules under **Policies**, then ask the agent
to run the commands:

| Outcome            | Rule                                                                             | Command                 |
| ------------------ | -------------------------------------------------------------------------------- | ----------------------- |
| Allowed by a rule  | Allow `shell` `command.run`, resource type `command`, starting with `git status` | `git status`            |
| Waits for a person | No rule needed                                                                   | `npm publish --dry-run` |
| Denied             | Deny `shell` `command.run`, resource type `command`, exactly `git push`          | `git push`              |

## Rule examples

[`examples/policies`](examples/policies) holds one rule file per pattern: read one
resource, require review for writes, and deny a sensitive operation. Try them
without an account using the policy engine's command line:

```sh
npx -p @nodrail/policy-engine nodrail-policy eval examples/policies \
  --tool github --operation issues.read --kind repository --resource acme/support
```

A simulation never approves anything or issues a permit.

## Compatibility

| Component            | Supported                                | Checked with      |
| -------------------- | ---------------------------------------- | ----------------- |
| Claude Code          | 2.1.295 or later, which adds `onFailure` | 2.1.322 on macOS, real CLI: a missing, timed-out or crashing hook blocks the tool |
| Codex                | 0.155 or later                           | 0.155.1 on macOS, real CLI |
| LangChain            | 1.x                                      | 1.6 agent loop    |
| Vercel AI SDK        | 7                                        | 7.0 agent loop    |
| OpenAI Agents SDK    | 0.21                                     | 0.21 agent loop   |
| MCP SDK              | 1.x                                      | 1.32 client and server |
| Mastra, LlamaIndex, Anthropic and OpenAI SDKs, Claude Agent SDK | Recognised by shape | Shape only |
| Node.js              | 22 or later                              | 22 and 24         |
| Linux                | Blocking paths checked on Alpine, arm64  | Node 22 in Docker |
| Windows              | Supported                                | Node 22 in CI; the agents' hooks not yet in the real CLIs |
| TypeScript consumers | `moduleResolution: bundler`              | TypeScript 7      |
| Protocol             | schema 1, canonicalizer 1                |                   |

How a Claude Code call maps to a rule is part of the contract. A change to it uses
new operation names, so an existing rule can never silently start matching
something else.

| Claude Code tool                                                               | Tool    | Operation          | Resource   |
| ------------------------------------------------------------------------------ | ------- | ------------------ | ---------- |
| Bash, PowerShell (one simple command)                                          | `shell` | `command.run`      | `command`  |
| Bash, PowerShell (chains, redirects, substitution, or running another program) | `shell` | `command.compound` | `command`  |
| Write                                                                          | `files` | `file.write`       | `file`     |
| Edit, MultiEdit                                                                | `files` | `file.edit`        | `file`     |
| NotebookEdit                                                                   | `files` | `notebook.edit`    | `file`     |
| WebFetch                                                                       | `web`   | `fetch`            | `url`      |
| WebSearch                                                                      | `web`   | `search`           | `query`    |
| `mcp__server__tool`                                                            | server  | tool               | `mcp_tool` |
| Codex `apply_patch` (one file)                                                 | `files` | `file.write`, `file.edit` or `file.delete` | `file` |
| Codex `apply_patch` (several files, or a rename)                               | `files` | `file.patch`       | `file`, id `patch:sha256:…` |
| Any other tool                                                                 | `claude-code` | the tool's name in lowercase | `tool` |

A command, URL or search that contains something that looks like a secret uses
`command.redacted`, `fetch.redacted` or `search.redacted` instead, so a rule for
the plain form can't cover it.

A name that is not already a lowercase key gets a short fingerprint, so `GitHub`
and `github` can never share a rule.

## What leaves your machine

- **File contents:** never. Only a fingerprint and the path.
- **Commands, URLs, searches, MCP and tool inputs:** sent so a person can review them, with
  anything that looks like a secret replaced by `[redacted]`. The filter is best
  effort, so keep secrets out of them. A fingerprint of the original binds an
  approval to the exact call.
- **Results:** only whether the tool succeeded and how long it took.

- **`run()` and `check()`:** `params` exactly as you pass them, with no
  redaction.

## Limits

- In Claude Code, reads (Read, Grep, Glob) aren't sent to Nodrail. The hook
  checks them on the machine and blocks any that reach a place credentials
  live, such as `.env*`, `~/.ssh` or `*.pem`. The check covers only the tools
  matched in the hook settings: anyone who can edit those settings, or a
  process outside the agent, can go around it. This is not a sandbox.
- File paths are resolved and URLs normalised before rules see them, in the
  machine's own form (`C:\repo\` on Windows). Shell prefix rules are a
  convenience, not a sandbox: prefer exact rules for commands.
- A person's approval covers one call. Retrying after the wait creates a new
  request.
- Each installation can make 600 calls a minute.
- A workspace has a monthly allowance of agent actions. Past it, new actions are
  blocked. Checks never stop running and nothing becomes allowed.
