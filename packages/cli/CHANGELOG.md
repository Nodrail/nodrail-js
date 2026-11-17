# Changelog

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
