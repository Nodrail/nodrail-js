# @nodrail/client

Checks with Nodrail before an agent runs a governed action. Anything other than a
fresh, exact allow blocks the call. A timeout, an error or an unknown answer all
mean the action does not run.

**Developer preview:** the API may still change before 1.0. Licensed under
[Apache-2.0](https://github.com/Nodrail/nodrail-js/blob/main/LICENSE). Report
vulnerabilities privately, as described in [SECURITY.md](SECURITY.md).

## Use it with any agent framework

Create an agent in Nodrail, choose **TypeScript SDK**, and copy the credential.
Then wrap the tools you already have:

```sh
export NODRAIL_CREDENTIAL="<the credential>"
```

```ts
import { guard } from "@nodrail/client";

const agent = createAgent({ model, tools: guard(tools) });
```

That is the whole integration. `guard` takes one tool, an array, a record of
tools or a plain function, and returns the same thing: a framework's tools keep
their exact type, and a plain function now returns a promise, since it asks
first. Each tool now runs only if Nodrail allows it. When it doesn't, the tool is not called
and the agent reads why as the tool's result, so it can tell the user or try
something else.

| Framework                | Pass to `guard`                       |
| ------------------------ | ------------------------------------- |
| LangChain, LangGraph     | your `tools` array                    |
| Vercel AI SDK            | your `tools` record                   |
| OpenAI Agents SDK        | your `tools` array                    |
| Mastra                   | a tool or record of tools             |
| LlamaIndex               | a tool or array of tools              |
| Anthropic SDK tool runner | your `tools` array                   |
| Claude Agent SDK         | the tools from `tool()`               |
| OpenAI SDK `runTools`    | your `tools` array                    |
| Anything else            | the function that does the work       |

If `guard` doesn't recognise something it throws straight away, so a tool can
never end up looking protected when it isn't.

### LangChain middleware

To cover every tool in a `createAgent` agent, including ones added while it runs:

```ts
import { nodrailMiddleware } from "@nodrail/client/langchain";

const agent = createAgent({ model, tools, middleware: [nodrailMiddleware()] });
```

Use this or `guard`. Using both still asks only once.

### Rules that look inside a call

By default a tool is ruled by its name: `send_email.call`, resource type `tool`.
To write rules about what it acts on, say so once:

```ts
guard(tools, {
  describe: {
    create_issue: (input) => ({
      tool: "github",
      operation: "issues.create",
      resource: { kind: "repository", id: input.repo },
    }),
  },
});
```

### Options

| Option      | Default                 | Meaning                                                   |
| ----------- | ----------------------- | --------------------------------------------------------- |
| `waitMs`    | `NODRAIL_WAIT_SECONDS`, or 5 minutes | How long a call waits for a person. `0` blocks at once. |
| `onBlocked` | `"return"`              | `"throw"`, or a function, to change what a blocked tool does. |
| `describe`  | the tool's name         | What rules see for this tool.                             |

Pass them to `guard`, or to `createNodrail()` for one configured instance with
its own `url` and `credential`.

### Without a framework

```ts
import { createNodrail } from "@nodrail/client";

const nodrail = createNodrail();

// Runs only if allowed. Anything else throws NodrailBlockedError.
await nodrail.run(
  { tool: "github", operation: "issues.create", resource: "acme/support" },
  () => createIssue(),
);

// Or ask, and act on the answer yourself.
const decision = await nodrail.check({ tool: "github", operation: "issues.delete" });
if (decision.allowed) await deleteIssue();
```

### Where the connection comes from

Nearest first: options you pass, `NODRAIL_URL` and `NODRAIL_CREDENTIAL`, then the
file `~/.nodrail/credential`. Only the credential is required.

With no credential nothing throws at startup. Every guarded call is blocked and
says what is missing, so an agent can never run unchecked because of the order
things were loaded in.

### What guard can't cover

- Tools that run on a provider's servers, such as hosted web search, have no
  function here to check. `guard` leaves them as they are.
- MCP servers attached directly to an agent aren't wrapped. Use the tools from
  your MCP client, or the LangChain middleware.
- Tools that never pass through `guard`, and code outside the agent.

## Claude Code and Codex

Install the plugin instead: see
[Nodrail/agent-plugins](https://github.com/Nodrail/agent-plugins). No code changes, and the
checks cover the shell, file edits and MCP tools.

The one-file hook is also here, at `dist/nodrail-hook.mjs`, for setting up by
hand. The settings are shown on the connect page in Nodrail.

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
without an account using `simulate` from `@nodrail/policy-engine`. A simulation never approves anything or issues a permit.

## Compatibility

| Component            | Supported                                | Checked with      |
| -------------------- | ---------------------------------------- | ----------------- |
| Claude Code          | 2.1.295 or later, which adds `onFailure` | 2.1.321 on macOS, real CLI |
| Codex                | 0.155 or later                           | 0.155.1 on macOS, real CLI |
| LangChain            | 1.x                                      | 1.6 agent loop    |
| Vercel AI SDK        | 7                                        | 7.0 agent loop    |
| OpenAI Agents SDK    | 0.21                                     | 0.21 agent loop   |
| Mastra, LlamaIndex, Anthropic and OpenAI SDKs, Claude Agent SDK | Recognised by shape | Shape only |
| Node.js              | 22 or later                              | 22 and 24         |
| Linux                | Blocking paths checked on Alpine, arm64  | Node 22 in Docker |
| Windows              | Not tested yet                           |                   |
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

A name that is not already a lowercase key gets a short fingerprint, so `GitHub`
and `github` can never share a rule.

## What leaves your machine

- **File contents:** never. Only a fingerprint and the path.
- **Commands, URLs, searches, MCP inputs:** sent so a person can review them, with
  anything that looks like a secret replaced by `[redacted]`. The filter is best
  effort, so keep secrets out of them. A fingerprint of the original binds an
  approval to the exact call.
- **Results:** only whether the tool succeeded and how long it took.

## Limits

- Tools that only read, such as Read and Grep, are not checked.
- File paths are resolved and URLs normalised before rules see them. Shell prefix
  rules are a convenience, not a sandbox: prefer exact rules for commands.
- The check only covers tools matched in the hook settings. Anyone who can edit
  those settings, or a process outside Claude Code, can go around it. This is not
  a sandbox.
- A person's approval covers one call. Retrying after the wait creates a new
  request.
- Each installation can make 600 calls a minute.
- A workspace has a monthly allowance of agent actions. Past it, new actions are
  blocked. Checks never stop running and nothing becomes allowed.
