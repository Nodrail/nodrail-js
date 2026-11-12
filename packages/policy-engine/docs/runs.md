# Runs, gates and budgets

This page covers gates, budgets and receipts: rules that depend on what already happened in a piece of work, how the Claude Code hook records that history, and how to test it.

A rule decides one action on its own. A gate decides an action given what has already happened in the same piece of work: "don't open the pull request until QA passed after the last code change". A budget limits how much an agent may do: "a builder step may make 60 tool calls".

Both are entries in the same rules files as rules, and need engine level 3 (see [Versions](#versions)). The engine stays a pure function: you pass the run's history with each decision, and it never reads files, clocks or networks to find it.

## Words

| Word | Meaning |
| --- | --- |
| Run | One piece of work, named by a key your integration chooses: an issue, a branch, a session. |
| Step | One agent working inside a run, from start to finish. Steps are named by agent: `dev`, `qa`, `reviewer`. |
| Receipt | What an agent reports when its step ends: a verdict, findings, and usage it reports. |
| Action | A decided tool call, recorded in the run with the step and agent that made it. |

Agent names in a run are the names of the steps (for Claude Code, the subagent type), not the Nodrail agent a rule's `agent:` field selects. Actions outside any step are agent `main`.

## Gates

```yaml
- required_engine_version: 3

- list: builders
  items: [dev, infra]

- rule: Dispatch subagents
  tool: claude-code
  operation: agent
  resource: { kind: agent, match: any }
  effect: allow

- gate: Review before the pull request
  id: review-before-pr
  tool: claude-code
  operation: agent
  resource: { kind: agent, match: exact, value: github }
  requires:
    - { agent: qa, verdict: pass, since: { list: builders } }
    - { agent: reviewer, verdict: [ship, ship_with_debt], since: { list: builders } }
  otherwise: require_approval
```

A gate matches exactly as a rule with the same fields would: `tool`, `operation` and `resource`, or `command`, plus `condition`, `agent`, `installation`, `expires` and `enabled`. Like a rule, it is named in decisions by its `id`, or by an id made from its name when it has none (see [Ids](rules.md#ids)). Instead of `effect` it has:

- `requires`: one or more requirements, all of which must be met.
  - `agent`: the step that must have finished.
  - `verdict`: one verdict or a list. Any of them meets it.
  - `since` (optional): an agent, a list of agents, or `{ list: <name> }`. The step must have started and finished after the latest work: anything these agents did (started, acted or finished), and any [change](#what-counts-as-a-change) by another agent than the one required. Without `since`, any time in the run counts.
- `otherwise`: `deny` or `require_approval`, applied while a requirement is unmet.

What a gate does:

1. **It never allows.** Met, it adds nothing, and your rules decide as usual. Unmet, it adds its `otherwise` effect as if it were a matching rule. Deny beats review beats allow, as always.
2. **No history means unmet.** With no run, a step that reported no verdict, or a verdict not in the list, the gate holds. So does a step whose start wasn't recorded.
3. **A builder still running counts as the latest work.** So does any action it took.
4. **The step must cover all of the work.** A QA step that started before the last build action and finished after it saw only part of the build, so it doesn't count.
5. **It never weakens the rules.** The rules decide first. An unmet gate can only make that stricter: when no rule matches, the action stays blocked even if the gate only asks for a review.

### What counts as a change

With `since`, the main agent, a general-purpose helper or any agent not in the list can also change the work after QA passed. Their changes count as work too. Agents the gate itself waits for are checking the work, so only their file edits count: a reviewer running the tests undoes nothing, a reviewer editing a file undoes an earlier QA pass, and no agent's changes undo its own requirement.

A change is:

- a file written, edited, patched or deleted, and a notebook edited;
- a shell command, except the read-only pack's look-around commands: `cd`, `ls`, `git status` and `git log` with any arguments, and `pwd`, `git branch`, `git diff` and `git diff --staged` as written.

Starting a subagent, reads, searches, web and MCP tools are not changes. `git push` is: a second push after the reviewed one needs a new review. An action that was denied changed nothing, so only actions that went ahead or went to a person count. The local hook and `nodrail-policy test` record this with each action as `change: true`; Cloud works it out from the action with the same function, `isChange()` from `@nodrail/policy-engine`. An action recorded without `change`, as before engine level 3, is not a change.

Gating the `github` dispatch does not stop the main agent running `git push` itself. Gate the command too:

```yaml
- required_engine_version: 3

- gate: Review before a push
  command: { prefix: git push }
  requires:
    - { agent: reviewer, verdict: [ship, ship_with_debt], since: [dev, infra] }
  otherwise: deny
```

A command gate follows command-rule matching: `git push` covers `git push origin main` but not `git pushy`, and it holds inside `git add . && git push`.

## Budgets

```yaml
- required_engine_version: 3

- budget: Builder step
  step_agent: dev
  per: step
  tool_calls: 60
  warn_at: 40
  otherwise: require_approval

- budget: Run spend
  per: run
  usd: 20
  otherwise: deny
```

- `per`: `step` or `run`.
- One limit: `tool_calls`, `tokens` or `usd`. Use one budget per limit.
- `step_agent` (optional): only that agent's steps. Without it, every agent.
- `warn_at` (optional): from this amount, decisions carry a warning and nothing else changes. Must be below the limit.
- `otherwise`: `deny` or `require_approval`, applied to every action the budget covers once it is used up, and to every action it covers that has no run to count in.
- `id`, `title`, `desc` and `enabled` work as they do for rules.

How it counts:

- `tool_calls` counts the actions recorded in the step or run, plus the one being decided. A limit of 60 allows the 60th call and holds the 61st.
- `tokens` and `usd` add the usage that finished steps reported. They are known only when a step ends, so they can be limited per run, not per step. Such a budget is used up when the total reaches the limit.
- Actions outside any step (agent `main`) count as one step that lasts the whole run.
- What an agent reports, the engine trusts. A budget on `usd` limits the spend agents report, not your provider's bill.
- With no run, there is nothing to count against, so a budget that covers the action applies its `otherwise`, as a gate with no history holds. The decision says `Budget run-spend needs a run to count USD, and this action has none.` Without a run, an action is the main agent's, so a budget with `step_agent` doesn't cover it.
- Like a gate, a budget never weakens the rules: when no rule matches, the action stays blocked.

## Receipts

An agent ends its step with a fenced block, as the last thing in its final message:

````markdown
QA finished: 14 checks, one finding.

```nodrail-receipt
verdict: pass
findings: [flaky-test]
```
````

Only the end of the message is read (the last 16 KB), and a block longer than 8 KB, fences included, is no receipt; Cloud takes the same 8 KB. `verdict` and each finding are lowercased, spaces become `_`, and they must be short words: up to 32 characters of `a-z`, `0-9`, `_` and `-`, starting with a letter or digit. A finding that isn't one is dropped; a verdict that isn't one leaves the step with no verdict. `tokens` and `usd` are optional numbers. A receipt followed by more text is treated as a quote and ignored, and so is any `agent` field: who ran comes from what the integration saw dispatched, not from what the agent wrote. Read one with `parseReceipt()` from `@nodrail/policy-engine/receipts`.

In Claude Code, tell each subagent to end with a receipt in its definition. For a subagent defined in `.claude/agents/qa.md`, add this at the end of the file:

````markdown
When you finish, end your final message with a `nodrail-receipt` block whose
`verdict` is `pass` or `fail`, and write nothing after it:

```nodrail-receipt
verdict: pass
findings: []
```
````

A reviewer usually compares the branch with `main`. The `repo-work` pack allows `git diff` only as written, because other arguments can write a file (`--output`) or read outside the project (`--no-index`), so allow the comparison you expect by name:

```yaml fragment
- rule: Compare with main
  command: git diff main
  effect: allow
```

The subagent's type, the `name` in the file's front matter, is the agent name gates and budgets use: `qa` here. A subagent that doesn't end with a receipt finishes with no verdict, so a gate waiting for it stays closed.

## Which agents can use them

Gates and budgets don't depend on the model or its provider: Nodrail sees tool calls, not the model. What differs is how much of the run each integration records for you.

| Integration | Run | Steps and receipts | Per-step budgets | Gates on another agent's step |
| --- | --- | --- | --- | --- |
| Claude Code, local hook (`nodrail-policy hook`) | Automatic | Automatic, from subagents | Yes | Yes |
| Claude Code, Nodrail plugin (Cloud) | Automatic | Automatic, from subagents | Yes | Yes |
| TypeScript SDK (`@nodrail/client`), with any framework: OpenAI Agents, Vercel AI SDK, LangChain, MCP, your own loop | `run` option or `NODRAIL_RUN` | Wrap each agent's work in `nodrail.step()` | Yes | Yes |
| Codex plugin | Automatic | None: Codex doesn't say which subagent makes a call | No | Only for steps recorded another way |
| [Cloud runtime API](https://nodrail.com/docs/runtime-api) (any language) | `run` on each intent | `POST /api/v1/runtime/steps` | Yes | Yes |
| This engine as a library | Pass `run` to `simulate()` | You keep the history, with `change` on actions | Yes | Yes |

In Cloud, a run belongs to the installation that reports it: another installation using the same key gets a run of its own, and can't record steps in yours. With Codex, gates on commands (`git push`) and per-run budgets work, because every call is the main agent's. Changes count as work in every integration: the local hook and `nodrail-policy test` record them, and Cloud works them out from each action it decides.

## Claude Code

`nodrail-policy hook` keeps a run ledger when your rules have a gate or a budget. Rules without them never read or write it. Add the step events next to `PreToolUse`, and don't exclude `Agent` from the matcher, because starting a subagent is what a dispatch gate decides:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "nodrail-policy hook /path/to/rules.yaml",
            "onFailure": "block"
          }
        ]
      }
    ],
    "SubagentStart": [
      { "hooks": [{ "type": "command", "command": "nodrail-policy hook /path/to/rules.yaml" }] }
    ],
    "SubagentStop": [
      { "hooks": [{ "type": "command", "command": "nodrail-policy hook /path/to/rules.yaml" }] }
    ]
  }
}
```

Claude Code sends the subagent's id and type with every event it makes. These are the step events the hook reads, trimmed to the fields it uses:

```json
{
  "hook_event_name": "SubagentStart",
  "session_id": "s-1",
  "cwd": "/home/me/app",
  "agent_id": "a1",
  "agent_type": "qa"
}
```

```json
{
  "hook_event_name": "SubagentStop",
  "session_id": "s-1",
  "cwd": "/home/me/app",
  "agent_id": "a1",
  "agent_type": "qa",
  "last_assistant_message": "All checks ran.\n\n```nodrail-receipt\nverdict: pass\n```"
}
```

What the hook does with each event:

| Event | Recorded | Decided |
| --- | --- | --- |
| `PreToolUse` | An action: tool, operation, outcome, and the step that took it (`agent_id`, `agent_type`), or `main` | Rules, gates and budgets, with the run's history |
| `SubagentStart` | The step starts | Nothing |
| `SubagentStop` | The step finishes, with the receipt read from its last message | Nothing; a step that sent no receipt finishes with no verdict |

Starting a subagent is `tool: claude-code`, `operation: agent`, with the subagent's type as an `agent` resource. Claude Code's earlier name for the tool, `Task`, is described the same way. Types are named the way runs name agents: lowercase, with anything but letters, digits, `_` and `-` turned into `-`, so `vercel:deployment-expert` is `vercel-deployment-expert`. A start with no type is `general-purpose`.

Two types that differ only in those characters get the same name: `team:qa` and `team-qa` are both `team-qa`, and a gate waiting for one is met by the other. Give the subagents you gate on names that stay apart.

### Upgrading rules for subagents

Before engine level 3, starting a subagent was described as a generic Claude Code tool, with resource `{ kind: tool, id: Agent }`. A rule written for that resource would never match, so a rules file with one is refused with a pointer to this section:

```yaml fragment
# Before
- rule: Start subagents
  tool: claude-code
  operation: agent
  resource: { kind: tool, match: exact, value: Agent }
  effect: allow

# After: any subagent, or match: exact, value: qa for one type
- rule: Start subagents
  tool: claude-code
  operation: agent
  resource: { kind: agent, match: any }
  effect: allow
```

The starter packs from `nodrail-policy init` already allow it.

The run is `NODRAIL_RUN` when it is set. Otherwise the first event of a Claude Code session picks the run, and the session keeps it:

- On a branch, `<repo>/<branch>`, such as `github.com/acme/app/fix-42`. The repository is the `origin` remote as host, owner and name, with no scheme, port, `.git` or credentials, or the name of the repository's folder when there is no remote.
- On the default branch (what `origin/HEAD` points to, else `main` or `master`), on a detached HEAD, or outside git, `session:<id>`, so sessions there don't share one long history.

Switching branch later in the session doesn't change its run, so `git switch` can't leave a gate's history behind. A new session on the new branch gets that branch's run. The session's run is kept in `.git/nodrail/sessions/`, next to the ledger. Keys are cut to 200 characters.

The ledger is one JSON Lines file per run in `.git/nodrail/runs/` of the repository (shared by its worktrees, never committed), or in `~/.nodrail/runs/` outside git. `NODRAIL_LEDGER` moves it, and the sessions go in a `sessions` folder inside it.

A ledger line that can't be read blocks the next action rather than being skipped, and an action that can't be recorded is blocked, so a budget never undercounts. The one exception is a last line with no line break, a write that was cut off: it is left out, and cut away before the next event is added. Each decision reads the run, decides and records while holding a lock file next to the run's file, so two calls at once can't both take a budget's last call; a call that waits more than 5 seconds for the lock is blocked, and a lock older than 30 seconds, left by a hook that died, is taken over. Recording a step never blocks the agent; if it fails, the step has no verdict and gates that need it stay closed.

`require_approval` asks the person at the keyboard. Their answer is Claude Code's, not recorded by Nodrail.

**Protect the ledger.** It is a file, and an agent that can write to `.git` can write a verdict into it. The `repo-work` starter pack denies file writes and edits under `.git`, shell redirection is never a simple command, so a prefix rule doesn't cover it, and both packs deny running `nodrail-policy` and `nodrail-claude-hook`, which could record a step by hand. If you write your own rules, deny writes to `.git` too, and if you move the ledger with `NODRAIL_LEDGER`, deny writes to that folder.

That is not enough against an agent set on it. `repo-work` lets the agent write tests and run them, and a test can write to the ledger like any other program. Local gates catch mistakes and keep an honest team of agents in order; they don't stop a determined agent. Cloud keeps the history on its server, where code the agent runs can't reach it.

### Reading the ledger

```sh
nodrail-policy runs                 # every run: steps, events, last activity
nodrail-policy runs show feature/x  # one run, step by step; allowed actions counted
nodrail-policy runs report          # per agent: steps, verdicts, held actions
```

### Testing gates

A cases file can carry the history a case runs in, so gates and budgets are tested in CI like rules. `run` lists what happened, in order:

- `{ started: <agent> }` starts a step of that agent.
- `{ finished: <agent>, verdict: <word> }` finishes its open step, or, with none open, records a whole step that starts and finishes there. `findings`, `tokens` and `usd` are optional.
- `{ action: <agent> }` records an allowed action by that agent that [changes](#what-counts-as-a-change) things. Add `command: git status` to record that command instead, which is a change unless it only looks around.

`step` names the agent taking the action being decided; without it, the action is the main agent's. These cases test the dispatch gate from [Gates](#gates) together with this budget:

```yaml
- budget: Short dev steps
  step_agent: dev
  per: step
  tool_calls: 2
  otherwise: require_approval
```


```yaml
- name: reviewed after the last build
  call: { tool: claude-code, operation: agent, kind: agent, resource: github }
  run:
    - { started: dev }
    - { finished: dev, verdict: done }
    - { finished: qa, verdict: pass }
    - { finished: reviewer, verdict: ship }
  expect: allow

- name: a third call in one dev step
  call: { command: ls }
  run:
    - { started: dev }
    - { action: dev }
    - { action: dev }
  step: dev
  expect: require_approval
```

```sh
nodrail-policy test rules.yaml --cases cases.yaml
```

`eval`, `check` and `exec` decide with no run, so every gate that matches holds, and every budget that covers the action applies its `otherwise`.

## Library

```ts
import { simulate, type RunContext } from "@nodrail/policy-engine";

const run: RunContext = {
  run: "feature/login",
  step: null, // or { id, agent } when a step takes this action
  events: [
    { type: "step.started", step: "s1", agent: "dev", at: "2026-11-11T10:00:00Z" },
    { type: "action", step: "s1", agent: "dev", at: "2026-11-11T10:05:00Z",
      tool: "files", operation: "file.edit", outcome: "allow", change: true },
    { type: "step.finished", step: "s1", agent: "dev", at: "2026-11-11T10:20:00Z",
      verdict: "done", findings: [], usage: {} },
    { type: "step.started", step: "s2", agent: "qa", at: "2026-11-11T10:21:00Z" },
    { type: "step.finished", step: "s2", agent: "qa", at: "2026-11-11T10:30:00Z",
      verdict: "pass", findings: [], usage: { usd: 0.4 } },
  ],
};

// document: compiled from the gate example above; descriptor: starting `github`
const result = simulate({ document, descriptor, now: new Date(), run });
result.outcome;     // "allow" | "require_approval" | "deny" | "none"
result.explanation; // "Gate review-before-pr needs reviewer with ship or ship_with_debt after the last change or dev or infra work."
result.gates;       // each gate: applies, missing requirements
result.budgets;     // each budget that covers this action: used, limit, ok | warn | over
result.warnings;    // budgets past warn_at
```

Events are read in the order given; `at` is recorded for people, not used to sort. Keep the history append-only. Record a step's start as well as its finish, and set `change: isChange(descriptor)` on each action that went ahead (not on denied ones): without it, a change by an agent outside `since` doesn't count as work.

## Hooks that report elsewhere

A hook that sends runs to a server rather than a local ledger can use `@nodrail/policy-engine/hook-runs`. It has no zod or YAML in it, so a bundled hook stays small:

- `runKey(cwd, sessionId, env)`: `NODRAIL_RUN`, else the key pinned to the session, `<repo>/<branch>` or `session:<id>` as [described above](#claude-code), or `null`. The same rule, and the same pins, as the local ledger.
- `receiptBlock(message)`: the receipt block that ends a message, fences included, or `null`. It reads only the end of the message and refuses a block over `MAX_RECEIPT_TEXT` (8192 characters). Pass it to `parseReceipt()` where YAML is at hand; it reads to the same receipt as the whole message.
- `agentName(text)`: how a step's agent is named.

The `@nodrail/client` Claude Code hook uses these to send each intent with its run and step, and each `SubagentStart` and `SubagentStop` as a step with its receipt block. A hook can't know whether an intent will go ahead, so the server records `change` with `isChange()` from the main entry once it has decided.

`@nodrail/policy-engine/receipts` reads receipts with no git and no files, and `legacySubagentRuleProblem()` from the main entry tells a rule form what the compiler says about a rule written for the old subagent resource.

## Versions

Two numbers are involved, and neither is the package version:

- The **engine level** is what a rules file asks for with `required_engine_version`. Level 2 added `contains` with a list; level 3 adds gates and budgets, and describes starting a subagent as an `agent` resource. A file that asks for more than the engine has is refused. Declare `required_engine_version: 3` in files with gates or budgets, so an older engine says why it refuses them.
- The compiled **document version**. A file with gates or budgets compiles to `version: 2`; a file without them still compiles to `version: 1`, unchanged. Engines before level 3 reject version 2 documents, so an older engine refuses gates instead of ignoring them.

## Limits

- The run key, steps and receipts are what your integration reports. The engine does not authenticate them, just as it does not authenticate `agent` or `installation`.
- A receipt is what the agent said. An agent told to say `pass` will. The gate guarantees the step happened and reported, in order, not that its judgement was right.
- Up to 200 compiled gates, 50 budgets and 20,000 events in one decision. The local ledger refuses a run that reaches 20,000 events, which blocks its next action: start a new run with `NODRAIL_RUN`.
