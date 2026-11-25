# @nodrail/client

Connect your agent’s tools to the Nodrail control plane, self-hosted or Nodrail Cloud, for the published policy, runs, budgets and decision history. A wrapped tool runs only after the client receives a fresh allow for the exact call. A denied request, a timeout or an invalid response blocks that invocation.

For local rules files with no server, use the [Nodrail policy engine](https://github.com/Nodrail/nodrail-js/tree/main/packages/policy-engine).

**Developer preview:** the API may still change before 1.0. Licensed under
[Apache-2.0](https://github.com/Nodrail/nodrail-js/blob/main/LICENSE). Report
vulnerabilities privately, as described in [SECURITY.md](SECURITY.md).

## Quick start

Use Node.js 22 or later. Start with a standalone tool to check your connection, then wrap the tools you already pass to your agent.

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

For a local self-hosted server on the default port, put both settings in your
untracked `.env` file and substitute your own installation credential. For
another deployment, use its origin, including `https://app.nodrail.com` for Cloud.

```dotenv
NODRAIL_URL=http://localhost:3000
NODRAIL_CREDENTIAL=ndr_...
```

For a saved installation credential, put its issuing origin in the adjacent
`url` file under `~/.nodrail/` (or `NODRAIL_HOME`). Existing installations
with only a `credential` file connect to Nodrail Cloud. A URL supplied to the
SDK may use an existing credential only when it matches the credential’s origin.

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

| Framework                 | Example                                                      | Pass to `guard`                                                    |
| ------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------ |
| Vercel AI SDK             | [`vercel-ai-sdk.ts`](examples/frameworks/vercel-ai-sdk.ts)   | your `tools` record                                                |
| LangChain, LangGraph      | [`langchain.ts`](examples/frameworks/langchain.ts)           | your `tools` array, or use the [middleware](#langchain-middleware) |
| OpenAI Agents SDK         | [`openai-agents.ts`](examples/frameworks/openai-agents.ts)   | your `tools` array                                                 |
| Your own loop             | [`plain-function.ts`](examples/frameworks/plain-function.ts) | the functions that do the work                                     |
| Mastra                    |                                                              | a tool or record of tools                                          |
| LlamaIndex                |                                                              | a tool or array of tools                                           |
| Anthropic SDK tool runner |                                                              | your `tools` array                                                 |
| Claude Agent SDK          |                                                              | the tools from `tool()`                                            |
| MCP SDK                   | [`mcp-server.ts`](examples/frameworks/mcp-server.ts)         | the server, with `guardMcpServer`, [see below](#mcp-servers)       |
| OpenAI SDK `runTools`     |                                                              | your `tools` array                                                 |

A framework's tools keep their exact type, so the result goes wherever the
original went. A plain function now returns a promise, since it asks first. If
`guard` doesn't recognise something it throws straight away, so a tool can never
end up looking protected when it isn't.

### What happens when the agent calls a tool

Before the tool's code runs, the client asks Nodrail whether this agent may make
this call with these arguments. Your team's rules in Nodrail decide:

- **Allowed:** the tool runs as before.
- **Denied:** the tool doesn't run. The agent gets the reason as the tool's
  result, so it can fix what is missing (a gate waiting for a review step, say)
  and try again, or tell the user. A call no rule covers is denied too.

Nothing waits for a person, and every decision is recorded. Rules change in
Nodrail, without a deploy.

### Try both

In a fresh test workspace, save this as `app.mjs`. Both SDK entry points
request a decision for the same harmless tool.

```js
import { createNodrail, guard, NodrailBlockedError } from "@nodrail/client";

function handbook_lookup() {
  return "Start with the public collection.";
}

const tools = guard({ handbook_lookup });
console.log(await tools.handbook_lookup());

const nodrail = createNodrail();
try {
  const result = await nodrail.run(
    {
      tool: "handbook_lookup",
      operation: "call",
      resource: { kind: "tool", id: "handbook_lookup" },
      params: {},
    },
    handbook_lookup,
  );
  console.log(result);
} catch (error) {
  if (!(error instanceof NodrailBlockedError)) throw error;
  console.log(error.message);
}
```

```sh
node --env-file=.env app.mjs
```

Both calls are denied in the empty policy and appear in **Activity**. Under
**Policies**, add this rule in the installation's environment and publish.

```yaml
- rule: Read the demo handbook
  tool: handbook_lookup
  operation: call
  resource: { kind: tool, match: exact, value: handbook_lookup }
  effect: allow
```

Run the same Node command again. Both results now contain the handbook text.

### In development and tests

Without a credential nothing throws: every guarded call is blocked and says the
credential is missing. In unit tests of the tools themselves, test the unwrapped
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

Guard the server before registering its tools. Every tool it registers from
then on is checked under the name it registers with:

```ts
import { guardMcpServer } from "@nodrail/client";

const server = guardMcpServer(
  new McpServer({ name: "github", version: "1.0.0" }),
);

server.registerTool(
  "delete_repo",
  { inputSchema: { repo: z.string() } },
  async ({ repo }) => deleteRepo(repo),
);
```

The check goes inside each tool the server keeps, so it holds when the server
calls the tool, and a later `tool.update({ callback })` is checked too.
Guarding a server that already has tools throws, rather than leaving them
unchecked. A blocked call answers the MCP client with `isError: true` and the
reason. Tested against the real `@modelcontextprotocol/sdk` client and server.

### Options

| Option      | Default                    | Meaning                                                                                                                                                      |
| ----------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `onBlocked` | `"return"`                 | `"throw"`, or a function, to change what a blocked tool does. Not used by the LangChain middleware, which always answers with an error message to the model. |
| `describe`  | the tool's name            | What rules see for each tool. `guard` only.                                                                                                                  |
| `name`      | the function's name        | Needed for a function with no name. `guard` only.                                                                                                            |
| `run`       | `NODRAIL_RUN`, else no run | The run calls belong to when no `inRun` or `step` says otherwise. `createNodrail()` only.                                                                    |
| `env`       | `process.env`              | Where `NODRAIL_*` settings are read from. `createNodrail()` only.                                                                                            |
| `fetch`     | the global `fetch`         | The function requests to Nodrail use. `createNodrail()` only.                                                                                                |
| `sleep`     | a timer                    | How the client waits before sending a lost report again, for tests. `createNodrail()` only.                                                                  |

`onBlocked` also goes to `createNodrail()`, which makes an instance with its own
`url`, `credential` and `adapterVersion`. Each request to Nodrail times out
after 10 seconds, and a call is decided at once: nothing waits for a person.

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
const decision = await nodrail.check({
  tool: "github",
  operation: "issues.delete",
});
if (decision.allowed) {
  await deleteIssue();
  await nodrail.report(decision, "success");
}
```

A plain string `resource` is resource type `resource`. With no `resource`, it is
type `tool` with the id `<tool>.<operation>`, such as `github.issues.delete`. `run()` and `check()` send
`params` exactly as you pass them, with no redaction: keep secrets out of them.

`run()` takes two more options. `timeoutMs` stops waiting for the call and
reports it as `unknown`, since it may still take effect; an `AbortError` or
`TimeoutError` from the call is reported the same way, any other error as
`failure`. `measure` reads the amounts the result measured, for budgets that
sum a `result.` path; the same list goes to `report(decision, "success", { measured })`.
Amounts are whole, non-negative numbers, each path once; if any isn't, none
is sent, and the budget treats the missing reading as unknown, never zero.
A report is keyed by its permit and retried a few times on a network or
server error, so it never counts twice.

```ts
await nodrail.run(refundAction, () => stripe.refunds.create(args), {
  timeoutMs: 10_000,
  measure: (refund) => [{ path: "result.amount", value: refund.amount }],
});
```

In a run, each call also sends the work revision it is about (`run.subject`,
the git work tree at `cwd`, read again when the permit is issued), so a gate
that needs evidence for this exact commit can be checked. Outside a git work
tree it is sent as unknown, which keeps such a gate closed. Pass
`subject: () => revision` to read it your own way, or `subject: null`.

### Runs and steps, for any framework

**SDK walkthrough preview.** The examples below require client 0.2.0 or later, which provides `inRun` and `step`.

Gates and budgets decide with what already happened in a piece of work: deny
the pull request until QA passed after the last change, or limit how many tool
calls one agent step makes. Tell Nodrail which run a call belongs to, and wrap
each agent's work as a step:

```ts
const nodrail = createNodrail({ run: "ENG-42" }); // or NODRAIL_RUN

await nodrail.step("dev", () => devAgent.run(task));
const review = await nodrail.step("qa", () => qaAgent.run(task));
await nodrail.step("github", () => releaseAgent.run(task)); // a gate denies its calls until met
```

Every guarded call made while a step runs belongs to it, through your agent
framework's tool loop too, so tools need no change. Steps running side by side
keep their own calls. `nodrail.inRun(key, work)` sets the run for one piece of
work, for a server handling many.

A step's verdict comes from its result: a string ending with a
`nodrail-receipt` block, or an object with `verdict` (and optional `findings`
and `usage: { tokens, usd }`). Pass `{ receipt: (result) => … }` as the third
argument to read your own shape. A step that throws finishes with no verdict,
and the error goes on. Recording a step never stops the work: if it can't be
recorded, gates that need it stay closed.

`step` needs a run, and throws if there is none. Without a run, calls are
decided as before, and any gate they match denies them.

### Where the connection comes from

Supply `url` and `credential` together in SDK options or set
`NODRAIL_URL` and `NODRAIL_CREDENTIAL` together. With no explicit settings,
the SDK uses the Cloud credential file in `NODRAIL_HOME` (by default
`~/.nodrail`). Addresses use `https`. Loopback addresses (`localhost`,
`127.0.0.1`, `::1`) also accept `http`.

With no credential nothing throws at startup: each guarded call is blocked and
says what is missing, and the next call looks again. So an application that loads
its secrets after importing its tools is checked as soon as they are there.

### When a call is blocked

The agent reads a sentence saying why, and `NodrailBlockedError.code` (or
`decision.code`) says the same for your code:

| Code                             | What it means                                                                   | What to do                                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `DENIED`                         | A rule denies it, no rule allows it, or a gate or budget isn't met              | Meet what the reason says is missing and try again, or change the rule if it should be allowed |
| `EXPIRED`, `INVALIDATED`         | The request timed out, or something changed                                     | Try again for a new decision                                                                   |
| `NOT_CONFIGURED`                 | No credential found                                                             | Pair `NODRAIL_URL` with `NODRAIL_CREDENTIAL`                                                                       |
| `UNAUTHENTICATED`                | The credential was refused                                                      | Check it, and that `NODRAIL_URL` points at your Nodrail                                        |
| `RATE_LIMITED`, `QUOTA_EXCEEDED` | Too many calls, or the month's allowance is used                                | Wait, or raise the plan                                                                        |
| `UNAVAILABLE`                    | Nodrail couldn't be reached                                                     | Check the network; nothing ran                                                                 |
| `INSECURE_URL`                   | `NODRAIL_URL` is plain `http` to another machine, so the credential wasn't sent | Use `https`. Plain `http` works only for `localhost`                                           |
| `INVALID_ACTION`                 | The call couldn't be described, for example a circular input                    | Pass plain JSON arguments                                                                      |

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

The Claude Code hook sends each intent with its run and the subagent taking it,
governs starting a subagent (`Agent`, or `Task` in older Claude Code), and
records `SubagentStart` and `SubagentStop` as steps with the receipt block the
subagent ended with (read from the last 16 KB of its message, up to 8 KB). The
run is `NODRAIL_RUN`, else `<repo>/<branch>` where the session started, such as
`github.com/acme/app/fix-42`, kept for the whole session so switching
branch doesn't change it; on the default branch or outside git it is the
session. The pin is kept in `.git/nodrail/sessions`. Gates and budgets in your rules use
that history. Any other agent uses
[runs and steps](#runs-and-steps-for-any-framework) in the SDK.

**Upgrading:** starting a subagent used to be ungoverned by the plugin. It is
now tool `claude-code`, operation `agent`, with the subagent's type as a
resource of type `agent` (`vercel:deployment-expert` becomes
`vercel-deployment-expert`). Until a rule allows it, each start is denied.
Rule files with a rule for the earlier resource, type `tool` with id
`Agent`, no longer compile.

The Codex hook sends the run the same way. Codex doesn't say which subagent
makes a call, so every call is the main agent's: gates on commands (such as
`git push`) and budgets per run work, and a gate waiting for another agent's
step stays unmet, and the call is denied, until that step is recorded some other way, for example with
`nodrail.step()` in a script.

To see each outcome, add these rules under **Policies**, then ask the agent
to run the commands:

| Outcome           | Rule                                                                             | Command                 |
| ----------------- | -------------------------------------------------------------------------------- | ----------------------- |
| Allowed by a rule | Allow `shell` `command.run`, resource type `command`, starting with `git status` | `git status`            |
| Denied, no rule   | No rule needed                                                                   | `npm publish --dry-run` |
| Denied by a rule  | Deny `shell` `command.run`, resource type `command`, exactly `git push`          | `git push`              |

## Rule examples

[`examples/policies`](examples/policies) holds one rule file per pattern: read one
resource, write only after a reviewer agent passed the work, and deny a
sensitive operation. Try them
without an account using the policy engine's command line:

```sh
npx -p @nodrail/policy-engine nodrail-policy eval examples/policies \
  --tool github --operation issues.read --kind repository --resource acme/support
```

A simulation never issues a permit.

## Compatibility

| Component                                                       | Supported                                 | Checked with                                                                      |
| --------------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------- |
| Claude Code                                                     | 2.1.295 or later, which adds `onFailure`  | 2.1.322 on macOS, real CLI: a missing, timed-out or crashing hook blocks the tool |
| Codex                                                           | 0.155 or later                            | 0.155.1 on macOS, real CLI                                                        |
| LangChain                                                       | 1.x                                       | 1.6 agent loop                                                                    |
| Vercel AI SDK                                                   | 7                                         | 7.0 agent loop                                                                    |
| OpenAI Agents SDK                                               | 0.21                                      | 0.21 agent loop                                                                   |
| MCP SDK                                                         | 1.x                                       | 1.32 client and server                                                            |
| Mastra, LlamaIndex, Anthropic and OpenAI SDKs, Claude Agent SDK | Recognised by shape                       | Shape only                                                                        |
| Node.js                                                         | 22 or later                               | 22 and 24                                                                         |
| Linux                                                           | Blocking paths checked on Alpine, arm64   | Node 22 in Docker                                                                 |
| Windows                                                         | Supported                                 | Node 22 in CI; the agents' hooks not yet in the real CLIs                         |
| TypeScript consumers                                            | `moduleResolution: bundler` or `nodenext` | TypeScript 7                                                                      |
| Protocol                                                        | schema 1, canonicalizer 1                 |                                                                                   |

How a Claude Code call maps to a rule is part of the contract. A change to it uses
new operation names or resource types, so an existing rule can never silently
start matching something else; at worst it stops matching, and the call is
blocked until the rule is updated.

| Claude Code tool                                                               | Tool          | Operation                                  | Resource                        |
| ------------------------------------------------------------------------------ | ------------- | ------------------------------------------ | ------------------------------- |
| Bash, PowerShell (one simple command)                                          | `shell`       | `command.run`                              | `command`                       |
| Bash, PowerShell (chains, redirects, substitution, or running another program) | `shell`       | `command.compound`                         | `command`                       |
| Write                                                                          | `files`       | `file.write`                               | `file`                          |
| Edit, MultiEdit                                                                | `files`       | `file.edit`                                | `file`                          |
| NotebookEdit                                                                   | `files`       | `notebook.edit`                            | `file`                          |
| WebFetch                                                                       | `web`         | `fetch`                                    | `url`                           |
| WebSearch                                                                      | `web`         | `search`                                   | `query`                         |
| `mcp__server__tool`                                                            | server        | tool                                       | `mcp_tool`                      |
| Agent (starting a subagent)                                                    | `claude-code` | `agent`                                    | `agent`, id the subagent's type |
| Codex `apply_patch` (one file)                                                 | `files`       | `file.write`, `file.edit` or `file.delete` | `file`                          |
| Codex `apply_patch` (several files, or a rename)                               | `files`       | `file.patch`                               | `file`, id `patch:sha256:…`     |
| Any other tool                                                                 | `claude-code` | the tool's name in lowercase               | `tool`                          |

A command, URL or search that contains something that looks like a secret uses
`command.redacted`, `fetch.redacted` or `search.redacted` instead, so a rule for
the plain form can't cover it.

A name that is not already a lowercase key gets a short fingerprint, so `GitHub`
and `github` can never share a rule.

## What leaves your machine

- **File contents:** never. Only a fingerprint and the path.
- **Commands, URLs, searches, MCP and tool inputs:** sent so rules can decide
  them and Activity can show them, with anything that looks like a secret
  replaced by `[redacted]`. The filter is best effort, so keep secrets out of
  them. A fingerprint of the original binds a decision to the exact call.
- **Results:** only whether the tool succeeded and how long it took.
- **Runs:** the run key each call belongs to (`NODRAIL_RUN`, else the
  repository and branch, such as `github.com/acme/app/fix-42`, without
  any credentials in the remote's URL, else the session), the step's
  agent name, and the receipt a step ends with: in Claude Code, the
  `nodrail-receipt` block that ends a subagent's last message, not the rest of
  it; with `nodrail.step()`, the receipt read from the step's result.
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
- Each installation can make 600 calls a minute.
- A workspace has a monthly allowance of agent actions. Past it, new actions are
  blocked. Checks never stop running and nothing becomes allowed.

## Applied projects

The standalone Claude Code plugin steps aside when `nodrail apply` has recorded the verified project hook in the user's home directory and the installed settings and policy files still match. Start a new session after installing a project hook. Set `NODRAIL_REQUIRE_STANDALONE=1` to require standalone authorization as well.

Set `NODRAIL_URL` and `NODRAIL_CREDENTIAL` together, or set both values in the Claude Code plugin options. Incomplete or conflicting pairs block governed calls. A saved credential file uses the Cloud origin.
