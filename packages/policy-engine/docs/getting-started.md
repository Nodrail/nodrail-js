# Write and test rules locally

Use one YAML file to answer three questions. May an agent inspect the working tree? May it remove untracked files? What happens if it asks to read the commit history? You can try all three on your machine without a Nodrail account.

## Install

Use Node.js 22 or later. Install the CLI, then open an empty directory for the example.

```sh
npm i -g @nodrail/policy-engine
```

With pnpm, run `pnpm setup` once so pnpm has a folder for global commands, then `pnpm add --global @nodrail/policy-engine`.

This page uses `nodrail-policy`. If you use [`nodrail`](../../cli/docs/cli.md), Nodrail's one command line, write `nodrail policy` instead: it takes the same commands and flags and gives the same output and exit codes.

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

The hook lets Claude Code continue on `allow` and blocks on `deny`, telling the agent why so it can change course. Nothing waits for a person. It blocks unmatched calls by default; `--unmatched allow` leaves those calls to Claude Code's own permissions instead. Keep `onFailure` set to `block` so an error starting the hook stops the covered call. Protect the hook settings and policy from changes by the agent.

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

**Repo work** also allows selected edits, tests and commits, and pushing feature branches. Save it as `repo-work.yaml`.

```sh
nodrail-policy init repo-work > repo-work.yaml
```

Its choices block damage rather than ask about it, and each is a rule you can change:

- **Pushes.** `git push origin <branch>` is allowed for a feature branch. A push that names `main` or `master` (or `HEAD:main`), `--all` or `--mirror`, and a push that names no branch (`git push`, `git push origin`), are denied: merging to main is for people to do. A force push whose flag comes first (`--force`, `-f`, `--force-with-lease`) is denied. A rule reads how a command starts, so protect main on the remote as well: a flag at the end, or a refspec such as `+feat` or `feat:main`, isn't seen.
- **Build scripts.** Writes and edits to `package.json`, `pnpm-workspace.yaml`, makefiles, `justfile`, `Taskfile.yml`, `node_modules` and `.npmrc` are denied, since they change what an allowed `npm test` or `make` runs. Add dependencies and scripts yourself, or drop those two rules if you trust the agent with what your tests run.
- **Workflows.** Writes and edits under `.github` are denied: workflows run with CI's secrets, and the files there decide who reviews a merge.
- **Control files** (`.git`, `.claude`, `.codex`, shell profiles, `nodrail.yaml` and its lock) and `rm -rf` are denied, as in every pack.

Validate the pack you chose with `nodrail-policy validate read-only.yaml` or `nodrail-policy validate repo-work.yaml`. Place the reviewed file at the project root and update the filename in the hook command to match. Keep the example cases paired with the original two-rule policy.

## Gate commands in scripts

For a script that needs an exit code, use `check`. It exits with 0 on allow and 1 when the policy blocks the command.

```sh
nodrail-policy check rules.yaml -- git status
```

## Share this policy with your team

This step needs a workspace on a Nodrail control plane: your own self-hosted server, or Nodrail Cloud. The control plane reads the same rules, so the `rules.yaml` you just tested imports as it is.

1. Sign in to your control plane and create a workspace. On Nodrail Cloud, [create a free workspace](https://app.nodrail.com/signup).
2. Open **Policies**, choose **Import YAML** and upload `rules.yaml`.
3. Choose **Preview** to see the rules the file adds, changes or removes, then **Publish rules**. The file replaces the environment's rules, so start from an empty environment or export the current rules first.
4. In **Agents**, choose **Connect an agent** and follow the steps for the [Claude Code plugin](https://nodrail.com/docs/agent-plugins). Its covered calls are then decided by the shared rules, and every decision is recorded for your team.

**Export YAML** brings the file back, so the copy in your repository and its `cases.yaml` stay the source you review. See [the console](https://nodrail.com/docs/cloud#policies).

## Where to go from here

- [Integrate your own harness](library.md#connect-a-custom-harness).
- [Look up rule fields](rules.md) or [check command matching](commands-and-tools.md).
- [Read the security model](security-model.md).
- [Add a ready-made policy to a repository](../../cli/docs/playbooks.md) with `nodrail add`.
- [Preview the run-history reference](runs.md). Its gates and budgets require engine feature level 3.
