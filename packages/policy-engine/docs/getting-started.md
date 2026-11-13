# Try APF locally

Use one YAML file to answer three questions. May an agent inspect the working tree? May it remove untracked files? What happens if it asks to read the commit history? You can try all three on your machine without a Nodrail account.

## Install

Use Node.js 22 or later and pnpm. Install the CLI, then open an empty directory for the example.

```sh
pnpm add --global @nodrail/policy-engine
```

## Write rules

Save this file as `rules.yaml`.

```yaml
- required_engine_version: 2
- rule: Inspect the working tree
  command: git status
  effect: allow
- rule: Protect untracked files
  command: git clean -fd
  effect: deny
```

Validate the file, then ask the evaluator about three proposed commands. Each command in quotes is input to the evaluator. Your working tree stays untouched.

```sh
nodrail-policy validate rules.yaml
nodrail-policy eval rules.yaml --command "git status"
nodrail-policy eval rules.yaml --command "git clean -fd"
nodrail-policy eval rules.yaml --command "git log"
```

Validation prints `OK` and a count of 2 rules. Each evaluation prints JSON. Read its `outcome` field.

| Proposed command | Expected outcome | Why |
| --- | --- | --- |
| `git status` | `allow` | Matches “Inspect the working tree”. |
| `git clean -fd` | `deny` | Matches “Protect untracked files”. |
| `git log` | `none` | Neither rule covers the proposed command. |

## Test your rules in CI

Save these expectations as `cases.yaml` alongside `rules.yaml`.

```yaml
- name: Inspecting the working tree is allowed
  call: { command: git status }
  expect: allow
- name: Cleaning untracked files is denied
  call: { command: git clean -fd }
  expect: deny
- name: A command without a matching rule is undecided
  call: { command: git log }
  expect: none
```

```sh
nodrail-policy test rules.yaml --cases cases.yaml
```

An exit code of 0 means all three expectations matched. A failed case exits with 1. Commit both files to review policy changes alongside their expected decisions.

## Connect Claude Code

This step is optional. To apply the example policy to covered tool calls, put `rules.yaml` at the root of a test project. In Claude Code 2.1.295 or later, add this entry to the project's `.claude/settings.json`. Merge it with any hooks you already use.

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "nodrail-policy hook \"$CLAUDE_PROJECT_DIR/rules.yaml\"",
            "onFailure": "block"
          }
        ]
      }
    ]
  }
}
```

The hook lets Claude Code continue on `allow`, blocks on `deny`, and asks the person at the keyboard on `require_approval`. It blocks unmatched calls by default. Set `--unmatched ask` if you want Claude Code to ask about those calls. Keep `onFailure` set to `block` so an error starting the hook stops the covered call. Protect the hook settings and policy from changes by the agent.

### Try the hook without Claude Code

From the example directory, send the hook a proposed call as JSON.

```sh
printf '%s' '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"git log"}}' | nodrail-policy hook rules.yaml
```

The JSON response contains `permissionDecision` set to `deny`. The evaluator found `none` for the same input. The hook applied its default for an unmatched call.

### Choose a starter policy for a project

The two-rule example is deliberately small. To start a project policy, choose a pack and review the generated file before pointing a hook at it. Run the chosen command in a directory where the named output file is new.

**Read-only** allows inspection. Save it as `read-only.yaml`.

```sh
nodrail-policy init read-only > read-only.yaml
```

**Repo work** also allows selected edits, tests and commits. Save it as `repo-work.yaml`.

```sh
nodrail-policy init repo-work > repo-work.yaml
```

Validate the pack you chose with `nodrail-policy validate read-only.yaml` or `nodrail-policy validate repo-work.yaml`. Place the reviewed file at the project root and update the filename in the hook command to match. Keep the example cases paired with the original two-rule policy.

## Gate commands in scripts

For a script that needs an exit code, use `check`. It exits with 0 on allow and 1 when the policy blocks the command.

```sh
nodrail-policy check rules.yaml -- git status
```

## Next

- [Use APF in your own harness](library.md#connect-a-custom-harness).
- [Look up rule fields](rules.md) or [check command matching](commands-and-tools.md).
- [Read the security model](security-model.md).
- [Preview the run-history reference](runs.md). Its gates and budgets require engine feature level 3.
