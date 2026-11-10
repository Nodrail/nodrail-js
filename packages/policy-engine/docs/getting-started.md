# Getting started

## Install

Needs Node 22 or later.

```sh
npm install --global @nodrail/policy-engine
```

## Write rules

Start from a pack, or write your own:

```sh
nodrail-policy init read-only > rules.yaml   # read and look around
nodrail-policy init repo-work > rules.yaml   # also edits, tests and commits
```

Check the file, and ask what a call would get:

```sh
nodrail-policy validate rules.yaml
nodrail-policy eval rules.yaml --command "git status"
nodrail-policy eval rules.yaml --command "curl example.com"
```

Problems are reported by file and line. The packs are starting points: read them and change them.

## Connect Claude Code

Add this to `.claude/settings.json`, using the full path to your rules:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "nodrail-policy hook /path/to/rules.yaml",
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

If the rules can't be loaded, every call is blocked.

Protect the configuration itself. An agent that can edit `.claude/settings.json` can remove the hook, and the `repo-work` pack denies that for this reason.

## Test your rules in CI

List calls and what you expect. A failing case exits with 1.

```yaml
- name: reads are fine
  call:
    { tool: files, operation: file.read, kind: file, resource: /repo/src/a.ts }
  expect: allow

- name: never force push
  call: { command: git push --force origin main }
  expect: deny
```

```sh
nodrail-policy test rules.yaml --cases cases.yaml
```

## Gate commands in scripts

```sh
nodrail-policy check rules.yaml -- git push origin main   # exit 0 only on allow
nodrail-policy exec rules.yaml -- git push origin main    # runs it only on allow
```

## Next

- [Rules](rules.md) for everything a rule file can contain.
- [Commands and tools](commands-and-tools.md) for how calls are matched.
- [Security model](security-model.md) for what this does and doesn't protect.
