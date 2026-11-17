# @nodrail/cli

Your [Nodrail](https://nodrail.com) workspace from the terminal: the requests
waiting for a person, Activity, runs, Insights and the rules file, with a
personal API token.

```sh
npm install -g @nodrail/cli
nodrail login
nodrail approvals --watch
```

Requires Node.js 22 or later.

> **Never give a token that can decide or publish to an agent Nodrail
> governs.** Nodrail exists so that a person, not the agent, decides. An agent
> holding a `decide` token could approve its own requests; one holding
> `rules:write` could rewrite the rules that hold it back. Agents and
> assistants get `read` tokens.

## Log in

Create a token in Nodrail under **your account → API tokens** (the menu on your avatar). Choose `read`, and
`decide` or `rules:write` only if you will approve requests or publish rules
from the terminal. The token starts with `ndp_` and is shown once.

```sh
nodrail login                       # paste it; nothing is echoed
echo "$TOKEN" | nodrail login --token-stdin
nodrail whoami
nodrail logout                      # forgets it here; revoke it under your account
```

The token is saved in `~/.nodrail/cli.json`, readable only by you (mode
`0600`, in a folder with mode `0700`), one per Nodrail address. When
`NODRAIL_TOKEN` is set it is used instead, which is the way to go in CI, but
only for the Nodrail it belongs to: `NODRAIL_URL`, or Nodrail Cloud. A
different `--url` never receives it. Tokens only travel over https, except to
`localhost`. Text from Nodrail, such as an agent's resource, is printed with
control characters escaped, so it can't redraw the terminal before you decide.

The command doesn't use the operating system's keychain: Node has no built-in
access to it, and the keychain's own commands take the secret as a
command-line argument, which other processes on the machine can read.

## Approvals

```sh
nodrail approvals                   # what is waiting, newest first
nodrail approvals --agent support-bot --watch
nodrail approve 6d1c2f0a-…          # approve once
nodrail reject 6d1c2f0a-…
```

`approve` and `reject` take the request's ID (the UUID `nodrail approvals`
lists), not its `APR-` reference. Each first shows exactly what will be
decided — agent, installation, tool and operation, resource, parameters and
when it expires — and asks. Without a terminal they refuse unless you pass
`--yes`. The decision names the action you were shown, so if the request
changed in between, nothing is decided.

There is no "Always" here: adding a rule goes through the rules file.

Every decision is recorded as you, "via API token _name_", and shows in
Activity.

## Activity, runs and Insights

```sh
nodrail activity --outcome denied --range 24h
nodrail activity --q acme/app --kind decisions --json
nodrail runs --agent dev-bot
nodrail run 7e2d3a1b-…
nodrail insights --days 7
```

`activity` takes the Activity page's filters: `--q`, `--agent`, `--outcome`
(`allowed`, `denied`, `held`, `waiting`, `expired`, `closed`), `--kind`
(`decisions`, `reports`, `changes`), `--range` (`24h`, `7d`, `30d`) and
`--run`. Lists show 50 items; `--limit` (up to 100) and `--cursor` page
through more.

## Rules

```sh
nodrail rules pull rules.yaml       # or to stdout without a file
nodrail rules push rules.yaml
```

`push` needs a token with `rules:write`. It previews the file, shows the
difference from the active rules and what would be added, changed or removed,
asks, and publishes exactly what it previewed. If someone changed the rules in
between, it refuses: pull again, merge, and push again.

## A project's policy (offline, no account)

A repository describes its policy in `nodrail.yaml`: catalog modules and its
own rules files, in the order they apply. The catalog ships inside this
package, so nothing is downloaded.

```sh
nodrail add @nodrail/open-reviewed-pr   # or its other name, @nodrail/pr_policy.yaml
nodrail add ./policies/team.yaml
# Give the module your repository in nodrail.yaml:
#   with: { repository: acme/widgets }
nodrail policy lock                     # shows who gains or loses what, records it
nodrail policy export --frozen > effective.apf.yaml
```

Commit `nodrail.yaml` and `nodrail.lock.yaml` together. The lock records the
exact version and file hashes of every module and file, and the reviewed
policy. `policy export --frozen` checks all of it, offline, and prints one
ordinary APF file only when everything matches. In CI, export to a temporary
file and replace the deployed one only on success: a shell redirect empties
the old file before nodrail runs.

The catalog:

| Module | Needs | What it lets an agent do |
| --- | --- | --- |
| `@nodrail/read-only` | nothing | Every agent reads, searches and runs commands that only look; credentials stay out of reach. The `read-only` starter pack. |
| `@nodrail/open-reviewed-pr` | `repository` | `github` opens draft pull requests after QA, checks and review pass on the current candidate. Never merges or starts its own checkers. |
| `@nodrail/merge-reviewed-pr` | `repository` | `merger` merges only after QA, checks and review pass on the head. Never pushes, changes files, uses the shell or starts its own checkers. |
| `@nodrail/triage-issues` | `repository` | `triage` reads, comments on and labels issues. Changes nothing else and uses no shell. |
| `@nodrail/dependency-updates` | `repository` | `deps` writes lockfiles (matched by file name) and refreshes them with scripts off. package.json changes, commits and pushes wait for a person; force-pushes are denied. Opens a draft once the checks pass. |

File and command rules apply wherever the Claude Code hook runs. GitHub rules
(`tool: github`, operations such as `pr.open` and `issues.comment` on a
`repository`) take effect only where an adapter maps GitHub calls to those
names and supplies the run's evidence; their guarantee covers the calls that
adapter mediates. Adding a module installs no hook and runs nothing; agents
follow a policy once you activate an export for them.

## Policies (offline, no account)

`nodrail policy` is
[`nodrail-policy`](https://www.npmjs.com/package/@nodrail/policy-engine), the
policy engine's command: the same commands, flags, output and exit codes,
with no token and nothing sent anywhere.

```sh
nodrail policy init repo-work > rules.yaml
nodrail policy validate rules.yaml
nodrail policy eval rules.yaml --command 'git status'
nodrail policy test rules.yaml --cases cases.yaml
nodrail policy check rules.yaml -- npm publish
nodrail policy hook rules.yaml      # a Claude Code hook; reads the event from stdin
nodrail policy --help               # every command and flag
```

Hooks and plugins that already run `nodrail-policy` keep working; both
answer Claude Code byte for byte alike.

## Options

| Option                 | Meaning                                                             |
| ---------------------- | ------------------------------------------------------------------- |
| `--json`               | Machine-readable output on stdout; notes and questions go to stderr |
| `-e`, `--environment`  | An environment's slug; the workspace's default otherwise            |
| `--url`, `NODRAIL_URL` | Nodrail's address, for self-hosting                                 |
| `-y`, `--yes`          | Don't ask before deciding or publishing                             |

Exit codes: `0` done, `1` failed (the error's code and request ID are
printed), `2` the command line was wrong.

## Library

`@nodrail/cli/api` is the typed client the command uses:

```ts
import { NodrailApi } from "@nodrail/cli/api";

const api = new NodrailApi({ token: process.env.NODRAIL_TOKEN! });
const { items } = await api.approvals();
```

The API itself is documented at
[nodrail.com/docs/api](https://nodrail.com/docs/api).

## License

Apache-2.0
