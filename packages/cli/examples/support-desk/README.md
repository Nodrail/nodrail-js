# Support desk: one setup, three hosts

A two-agent team, set up on Claude Code, Codex or Copilot from the same files. **marketing** starts every session and writes from the handbook. **support** answers from the handbook's internal collection too. Who may do what is in the policy, not in the agents' instructions, and each tool call is checked before it runs.

| | marketing | support |
|---|---|---|
| Search the `public` handbook | allowed | allowed |
| Search the `internal` handbook | denied | allowed |
| Publish to `help-center` | denied | allowed |
| Publish to any other channel | denied | denied |
| Hand work to the other | may start support | can't start anyone |

You need the `nodrail` that ships this example, Node 22 or later, and Claude Code 2.1.295 or Codex 0.169.0 or GitHub Copilot CLI 1.0.114 or later, signed in with your own account. On Windows, use Claude Code. This example needs no Nodrail account.

`nodrail.yaml` names the versions this example was last run with (`tested:`); see [Compatibility](../../docs/compatibility.md) for what was verified and the limits. `plan` shows `✓ tested` when yours match, and `? tested: unverified here: …` when they don't. That is information, not an error: newer hosts are expected to work, but nobody has shown it yet.

## Set it up

Use one host per checkout for this walkthrough. Copy the example, then run
the plan and apply pair for your host.

```sh
nodrail example support-desk ./desk
nodrail plan  ./desk --runtime claude-code
nodrail apply ./desk --runtime claude-code
nodrail plan  ./desk --runtime codex
nodrail apply ./desk --runtime codex
nodrail plan  ./desk --runtime copilot
nodrail apply ./desk --runtime copilot
```

`plan` only reads: it shows the revision it sets up, the files each host gets, the two connections with the exact command each runs, and the checks. It starts nothing and reads no secret. `apply` shows the same plan, asks, and only then starts each connection once to check it offers what it declares, before writing.

Codex runs a project's hooks only once you trust them. After `apply --runtime codex`, open `codex` in `./desk`, trust the folder, run `/hooks` and trust nodrail's hook, and quit. For Copilot, open `copilot --agent marketing` in `./desk` and choose to remember the folder. For each host you set up, check the installed hook:

```sh
nodrail plan ./desk --runtime claude-code --require-active   # Policy hook: configured
nodrail plan ./desk --runtime codex --require-active         # Policy hook: verified
nodrail plan ./desk --runtime copilot --require-active       # Policy hook: configured
```

`--require-active` requires the current, enforcing hook. For Claude Code and Copilot, `configured` means the hook is present and enabled in settings. For Codex, `verified` means Codex confirmed hook trust. To verify Claude Code at runtime, try the calls below. For a connected project, use **Verify the first check-in** in **Agents → Connect a project** and look for the matching Activity decision.

The lock records the whole workspace: the policy, the agents' instructions and every skill file. If you change any of them, `plan` names the file and `apply` waits until you run `nodrail policy lock` in `./desk` and review the change.

## Try it

Open `claude` or `codex` in `./desk`; it starts as marketing. Ask:

> Check what the desk lets you do: 1. Search the handbook's internal collection for escalation. 2. Hand the same search to the support agent, and ask it to then publish a one-line summary to the blog channel and report both answers. 3. Publish the same line to the blog channel yourself. 4. Search the internal collection for escalation once more. One line per step, with what the policy answered.

You should see marketing's search denied, support's allowed, support's publication to the blog denied (it may publish only to help-center), marketing's publication denied, and marketing's second search denied again. Then count what happened, whatever the agents said:

```sh
cat desk/activity/reads.jsonl          # one line per read; only support may read internal (it may retry)
find desk/outbox -name '*.md' ! -name README.md | wc -l   # 0 publications
```

Both agents are set up with the `cite-sources` skill, which asks them to end an answer from the handbook with a `Sources: …` line.

For Copilot, open `copilot --agent marketing` in `./desk` and ask for a
public search and an internal search. The public search is allowed and the
internal one is denied. Copilot checks tool calls against the session's entry
agent, including calls from subagents.

## Share the project

Commit `.gitignore`, `nodrail.yaml`, `nodrail.lock.yaml`, and the project sources such as rules, resources, skills, and handbook files. Each teammate runs `nodrail apply` to recreate host files. The example ignores generated host settings, hooks, MCP configuration, and `.nodrail/` state, along with local reads and publications.

## Swap the handbook for your own search service

The handbook connection searches `./handbook`. To search a service instead, start the one in `search-service/`, or point at your own that answers the same way:

```sh
SEARCH_SERVICE_TOKEN=change-me node desk/search-service/server.mjs 8091
```

In `nodrail.yaml`, replace the `handbook` connection's command line, and pass the token by reference:

```yaml
  handbook:
    command: nodrail
    args: [connector, http-search, --endpoint, http://127.0.0.1:8091/search]
    env:
      SEARCH_TOKEN: { fromEnv: SEARCH_SERVICE_TOKEN }
    operations:
      search: { resource: { kind: collection, from: collection } }
```

Then `nodrail policy lock` in `./desk`, and `apply` again for each host, with `SEARCH_SERVICE_TOKEN` set. The agents, the skill and the policy don't change; ask the same question and count the reads in `activity/service-reads.jsonl`. No file holds the token: `plan` names it, and only the connection gets it.

## Send decisions to OpenTelemetry

Uncomment `telemetry` in `nodrail.yaml` and point it at a receiver, such as an OpenTelemetry Collector on `http://127.0.0.1:4318/v1/traces`. Lock, apply, and each decision arrives as a `nodrail.decision` span with the agent, the decision and the host's call id; never the question. `nodrail plan` says how sending went.

## What's here

| Path | What it is |
|---|---|
| `nodrail.yaml` | The setup: hosts, resources, policy, connections |
| `nodrail.lock.yaml` | What was reviewed, by digest; `plan` refuses a setup that differs |
| `resources/` | The two agents, their instructions, and the team |
| `skills/cite-sources/` | The skill both agents load |
| `policies/desk.yaml` | Who may search what, and who may publish |
| `handbook/` | The documents searched, one folder per collection |
| `activity/`, `outbox/` | Reads and publications, written by the connections |
| `search-service/` | A search service of your own, for the swap |

If your own instructions for Claude Code or Codex (such as `~/.codex/AGENTS.md`) make agents run a command at the start, the desk's policy blocks it until a rule allows it.
