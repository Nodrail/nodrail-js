# Changelog

## 0.2.0

### Added

- `nodrail.yaml` may point at setup resources (preview): agents, a team, your
  own policies and the bindings that give a module's roles to your agents.
  `policy lock` and `export --frozen` read them, folders included; see
  [Give the roles to your agents](docs/playbooks.md#give-the-roles-to-your-agents-preview).
- `nodrail plan` (preview) shows what `nodrail apply` would set up for the
  team on Claude Code: agent files, skills, the effective policy and the
  settings that start the entry agent behind the policy hook. It only reads,
  marks with `!` anything apply would refuse (a file it didn't write, one
  edited since, a link, a missing `claude` or `nodrail`, a stale lock), and
  exits with 1 then. `--json` gives the same for scripts.
- `nodrail apply` (preview) makes that plan, after showing it and asking (or
  `--yes`). It refuses anything marked `!`, re-plans as the project's only
  writer and stops if anything changed since you saw it, and journals every
  change so that a stop partway is finished by the next `nodrail`. It
  changes and removes only the files it wrote and that still hold what it
  wrote, records them in `.nodrail/setup-state.json`, and opens Claude Code
  with `start: true`.
- `nodrail plan` and `apply` set up Codex too (`runtime: codex`): the entry
  agent in `.codex/config.toml`, the other members in `.codex/agents/`, skills
  in `.agents/skills/` and the hook in `.codex/hooks.json`, which denies when
  `nodrail` can't run. Codex runs a project's hooks only once the person
  trusts the folder and the hook; nodrail asks Codex, read-only, whether it
  does, says which step is missing, and `apply` exits with 1 until then.
- `apply` writes `.nodrail/protected.txt`, every file the setup is made from,
  and both hooks pass it with `--protect-list`, so no agent can edit the
  resources, policies, instructions or skills and apply them. On Codex the
  hook's command changed: trust it again in `/hooks` after `apply`.
- `apply` never takes a file that merely matches what it would write: only
  files it created or updated are its own, so it never removes yours.
- `.claude/settings.json` behind a link, or with `disableAllHooks` on, is a
  conflict. The Codex hook runs with `--host codex`. The write lock is
  claimed whole, so two nodrail processes can't both hold it.
- `@nodrail/read-only` 1.0.1 is the updated read-only pack.
- `apply` says what an open session picks up: a new session for changed
  agent files, skills or settings; the policy from the next tool call.
- `@nodrail/open-reviewed-pr` and `@nodrail/merge-reviewed-pr` 1.0.1 declare
  the `dev` role their gates already use, so a binding names every role it
  must map. A project locked at 1.0.0 stays there until it adds 1.0.1.

### Changed

- `nodrail policy` is `@nodrail/policy-engine` 0.4.0's. Its hook judges each
  call as the agent the host says made it, not always as `--agent`; reads
  Codex's agent calls; judges shell reads such as `cat` and `rg` as the file
  reads they are; and adds `--protect-list` and `--host codex`. See the
  engine's changelog.

## 0.1.0

First release: your Nodrail workspace from the terminal, with a personal API
token (`ndp_…`).

- `nodrail login`, `logout` and `whoami`. The token is saved in
  `~/.nodrail/cli.json`, readable only by you; `NODRAIL_TOKEN` always wins.
- `nodrail approvals` (with `--watch`), `approve <id>` and `reject <id>`, which
  show exactly what is being decided and ask before deciding unless `--yes`.
- `nodrail activity`, `runs`, `run <id>` and `insights`, with the filters of
  the Activity page.
- `nodrail rules pull` and `rules push`, which previews, shows the diff and
  publishes exactly what was previewed.
- `nodrail policy`: the policy engine's offline commands (`init`, `validate`,
  `compile`, `eval`, `test`, `check`, `exec`, `hook`, `runs`), the same as
  `nodrail-policy`, with no account.
- `nodrail add`, `nodrail policy lock` and `nodrail policy export --frozen`:
  a repository's policy as `nodrail.yaml` and `nodrail.lock.yaml`, offline.
  Lock shows the permission changes since the last committed lock; frozen
  export prints one APF file only when every file, version and value matches
  the lock. Writes are staged in your home and can't be left half done.
- A catalog shipped in the package: `@nodrail/read-only`,
  `@nodrail/open-reviewed-pr` (also `@nodrail/pr_policy.yaml`),
  `@nodrail/merge-reviewed-pr`, `@nodrail/triage-issues` and
  `@nodrail/dependency-updates`.
- `--json` on every command, `--environment`, and `NODRAIL_URL` or `--url` for
  self-hosting.
- `@nodrail/cli/api`: the typed API client the command uses.
