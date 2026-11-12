# Getting started

This guide takes you from nothing to rules that Claude Code checks before every call: install the engine, write rules, connect the hook, and test the rules in CI.

## Install

Needs Node 22 or later.

```sh
npm install --global @nodrail/policy-engine
```

## Write rules

Start from a pack, or write your own. Keep the rules in `.claude/nodrail/`: the `repo-work` pack denies file writes and edits anywhere under `.claude`, and the hook itself never lets a file tool change the rules it loaded.

```sh
mkdir -p .claude/nodrail
nodrail-policy init read-only > .claude/nodrail/rules.yaml   # read and look around
nodrail-policy init repo-work > .claude/nodrail/rules.yaml   # also edits, tests and commits
```

Check the file, and ask what a call would get:

```sh
nodrail-policy validate .claude/nodrail/rules.yaml
nodrail-policy eval .claude/nodrail/rules.yaml --command "git status"
nodrail-policy eval .claude/nodrail/rules.yaml --command "curl example.com"
```

Problems are reported by file and line. The packs are starting points: read them and change them.

## Connect Claude Code

Add this to `.claude/settings.json`. Claude Code sets `CLAUDE_PROJECT_DIR` to the project's folder for every hook:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "nodrail-policy hook \"$CLAUDE_PROJECT_DIR/.claude/nodrail/rules.yaml\"",
            "onFailure": "block"
          }
        ]
      }
    ]
  }
}
```

Keep `onFailure: "block"`, which needs Claude Code 2.1.295 or later, so a broken hook stops calls instead of letting them through.

| Outcome            | What Claude Code does                                                       |
| ------------------ | --------------------------------------------------------------------------- |
| `allow`            | Carries on. Its own permissions still apply, so a rule can only narrow them |
| `deny`             | Blocks the call and tells the agent why                                     |
| `require_approval` | Asks the person at the keyboard                                             |
| No rule            | Blocks the call. `--unmatched ask` asks instead                             |

If the rules can't be loaded, every call is blocked. Writing, editing, patching or deleting the rule files the hook was given, or any file inside a folder it was given, is always denied, before any rule is read.

### Try the hook without Claude Code

The hook reads one Claude Code event on stdin, so you can send it one yourself:

```sh
printf '%s' '{"hook_event_name":"PreToolUse","cwd":"'"$PWD"'","tool_name":"Bash","tool_input":{"command":"curl example.com"}}' \
  | nodrail-policy hook .claude/nodrail/rules.yaml
```

- An allow prints nothing and exits 0, which leaves the call to Claude Code's own permissions.
- A deny or a review prints Claude Code's JSON answer and exits 0. `permissionDecision` is `deny` or `ask`, and `permissionDecisionReason` names the rule. With the `repo-work` pack, `curl example.com` has no rule, so it is denied.
- Rules that can't be loaded print the problem on stderr and exit 2, which Claude Code treats as blocked.
- With budgets in the rules, a budget past its `warn_at` adds a line on stderr.

Use `printf '%s'` rather than `echo`: some shells' `echo` turns `\n` in the JSON into real line breaks, and the event no longer parses.

The packs allow Claude Code's own tools that only plan or talk to you, such as asking a question or presenting a plan, and starting any subagent; what a subagent then does is decided call by call. Its other own tools are `tool: claude-code` with the tool's name in lowercase as the operation: allow the ones you use. Starting a subagent is operation `agent` with the subagent's type as an `agent` resource, so `resource: { kind: agent, match: exact, value: qa }` allows starting `qa` only. Rules written before engine level 3 for `{ kind: tool, id: Agent }` no longer match: see [Upgrading rules for subagents](runs.md#upgrading-rules-for-subagents). This hook answers in Claude Code's format; for Codex, use the [Nodrail plugin](https://github.com/Nodrail/agent-plugins).

Protect the configuration itself. An agent that can edit `.claude/settings.json` can remove the hook, and the `repo-work` pack denies that for this reason. Both packs also deny running `nodrail-policy` and `nodrail-claude-hook` from the shell: those are for you, not the agent.

## Test your rules in CI

List calls and what you expect. A failing case exits with 1. These cases assume the `repo-work` pack; with `read-only`, the force push has no rule, so it gets `none`.

```yaml
- name: reads are fine
  call:
    tool: files
    operation: file.read
    kind: file
    resource: /repo/src/a.ts
    params: { path: /repo/src/a.ts, path_parts: [repo, src, a.ts] }
  expect: allow

- name: never force push
  call: { command: git push --force origin main }
  expect: deny
```

```sh
nodrail-policy test .claude/nodrail/rules.yaml --cases cases.yaml
```

A case has only the params you give it. `repo-work` allows writes and edits only with `inside_cwd: true`, so a write case needs it: `params: { path: /repo/src/a.ts, path_parts: [repo, src, a.ts], inside_cwd: true }` with `operation: file.write`.

## Gate commands in scripts

```sh
nodrail-policy check .claude/nodrail/rules.yaml -- git push origin main   # exit 0 only on allow
nodrail-policy exec .claude/nodrail/rules.yaml -- git push origin main    # runs it only on allow
```

## Next

- [Rules](rules.md) for everything a rule file can contain.
- [Runs, gates and budgets](runs.md) to hold an action until another agent's step passed, or limit how much a step may do.
- [Commands and tools](commands-and-tools.md) for how calls are matched.
- [Security model](security-model.md) for what this does and doesn't protect.
