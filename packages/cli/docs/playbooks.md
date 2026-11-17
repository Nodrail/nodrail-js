# Playbooks

> **Preview.** Playbooks need `@nodrail/cli` 0.1.0 or later. Modules with gates need APF engine feature level 3: see [Runs, gates and budgets (preview)](../../policy-engine/docs/runs.md).

A playbook is a policy for one way of working, packaged so a repository can add it by name: "a publisher agent may open a draft pull request once QA and review passed", or "a triage agent may label issues and nothing else". You add it with `nodrail`, give it your values, review what it permits, and commit the result. Your agents follow it once you activate an export of it.

Everything on this page works offline, with no account. It needs the [`nodrail` command line](cli.md).

```sh
npm i -g @nodrail/cli
```

## Projects, modules and the lock

A repository's policy is described by two files at its root. Commit both.

- **`nodrail.yaml`**, the manifest. It lists what the policy is made of, in order, under `imports`. An import is a catalog module, such as `@nodrail/open-reviewed-pr`, with its values under `with:`, or a `.yaml` file in your repository. A local file is either an ordinary APF rules file or another manifest with its own `imports`.
- **`nodrail.lock.yaml`**, the lock. `nodrail` writes it. It records the exact version of each catalog module, the SHA-256 of every file, the values each module was given, the import graph and order, the digest of the effective policy, and the effective policy last reviewed.

A **module** is a set of APF files with a name and a version, plus the values it needs, such as your repository. The catalog of modules ships inside `@nodrail/cli`, so adding one downloads nothing.

```yaml
kind: nodrail.project/v1
imports:
  - ref: "@nodrail/open-reviewed-pr"
    with:
      repository: acme/widgets
  - ref: ./policies/team.yaml
```

The **effective policy** is every imported file compiled together, in order, into one APF file. That file is what an agent's hook or adapter reads.

## Quickstart

This adds `@nodrail/open-reviewed-pr` to a repository. Run each command at the repository's root.

**1. Add the module.**

```sh
nodrail add @nodrail/open-reviewed-pr
```

```text
Added @nodrail/open-reviewed-pr@1.0.0
Changed: nodrail.yaml, nodrail.lock.yaml
  @nodrail/open-reviewed-pr: configuration required. Set with.repository in nodrail.yaml.
Permissions: pending until every module has its values.
```

The module is in `nodrail.yaml` but not in effect: it needs a value. `add` lists its rules below this, so you can read them first.

**2. Give it your repository.** In `nodrail.yaml`, set the value as `owner/name`:

```yaml
with:
  repository: acme/widgets
```

**3. Lock and review.**

```sh
nodrail policy lock
```

```text
Updated nodrail.lock.yaml
Permissions:
  3 permission changes.

  Agent github
    github.pr.merge
      repository (any)
          tightened     rule no-merge "Keep merge outside the publisher role": added (deny)
    github.pr.open
      repository exact "acme/widgets"
          granted       rule open-draft "Open a reviewed draft": added (allow)
                        where draft eq true
                        where targetScope eq "candidate"
          tightened     gate reviewed-draft "Require QA, checks and review on the candidate": added: deny until qa: pass since dev; gatekeeper: pass since dev; reviewer: ship since dev
Effective policy:
  …
```

Read the permissions first, then the lines of the effective policy that changed. See [Reading the review](#reading-the-review).

**4. Commit both files.**

```sh
git add nodrail.yaml nodrail.lock.yaml
git commit -m "Let the publisher open reviewed draft pull requests"
```

Reviewers see the same change in the pull request: the manifest, and the lock with the reviewed policy in it.

**5. Export.**

```sh
nodrail policy export --frozen > effective.apf.yaml
```

The export is one ordinary APF file. Check it like any other with `nodrail policy validate effective.apf.yaml`.

**6. Activate it.** Until now nothing governs an agent. Adding a module installs no hook and runs nothing. Agents follow the policy once you point an enforcement point at the export. See [Activate an export](#activate-an-export).

## What the lock checks

`nodrail policy export --frozen` reads only what was locked. Before it prints anything it checks, offline:

- `nodrail.yaml` is the file that was locked;
- each local file has the hash the lock recorded, and nothing was added to or dropped from the imports;
- each catalog module is the locked version, and every one of its files has the locked hash;
- every module has its values;
- the import order and the effective policy are the ones locked;
- the lock wasn't made by a newer engine level than this `nodrail` has.

When anything differs, it prints nothing on stdout, gives the reason on stderr and exits with 1:

```text
nodrail: policies/team.yaml changed since it was locked. Run `nodrail policy lock` to review it.
```

So an export always matches the policy someone reviewed and committed. To change the policy, edit the files, run `nodrail policy lock`, read the review and commit again.

### Versions

`nodrail add @nodrail/open-reviewed-pr` takes the catalog's version. `nodrail add @nodrail/open-reviewed-pr@1.0.0` asks for that exact version; a version the catalog doesn't have is refused, and nothing changes. Once locked, a module stays at its version.

If a module's files at the locked version don't match the hashes in the lock, `lock` and `export --frozen` both stop:

```text
nodrail: @nodrail/open-reviewed-pr@1.0.0 doesn't match nodrail.lock.yaml (policies/open.yaml). The installed package was changed; reinstall nodrail, or ask for another version with `nodrail add @nodrail/open-reviewed-pr@<version>`.
```

That is an error, never an update. The same version must always mean the same files.

## Reading the review

`nodrail add` and `nodrail policy lock` print what the change does to permissions since the policy last reviewed, grouped by agent, then operation, then resource. Each change has one label.

| Label          | Meaning                                                             |
| -------------- | ------------------------------------------------------------------- |
| `granted`      | An allow that wasn't there: the agent may now do this.              |
| `revoked`      | An allow removed: the agent may no longer do this.                  |
| `tightened`    | Less is allowed: a deny or a gate added, or an allow narrowed.      |
| `loosened`     | More is allowed: a deny or a gate removed, or an allow widened.     |
| `changed`      | It changed, but not simply more or less, such as a mix of both.     |
| `needs review` | The tool can't tell whether it is more or less. Read both versions. |

A `!` before the label marks a change that weakens a deny or a gate, and the count at the top says how many there are. Read those first.

```text
3 permission changes, 1 marked ! weaken a deny, a gate or a budget.
…
      ! loosened      gate review-first "Review first": …
```

After the permissions, `Effective policy:` shows the lines of the exported file that changed, with `+` and `-`.

## Use it in CI

Pin the `nodrail` version you lock with, and build the export from the committed files only. A shell redirect empties the target file before `nodrail` runs, so export to a temporary file and replace the deployed file only on success:

```sh
set -e
nodrail policy export --frozen > effective.apf.yaml.tmp
nodrail policy validate effective.apf.yaml.tmp
mv effective.apf.yaml.tmp effective.apf.yaml
```

A pull request that changes `nodrail.yaml` or a local file without running `nodrail policy lock` fails here, with the reason. To check expected decisions too, run [`nodrail policy test`](../../policy-engine/docs/cli.md#test) against the export with a cases file.

## The catalog

| Module                        | What it does                                                                                                                                                                                 | Values       |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `@nodrail/open-reviewed-pr`   | A publisher agent (`github`) may open draft pull requests after QA, a gatekeeper and a reviewer accept the current candidate. Merging stays denied. Also named `@nodrail/pr_policy.yaml`. | `repository` |
| `@nodrail/merge-reviewed-pr`  | A separate `merger` agent may merge only after QA, the checks and a review pass on the current head.                                                                                         | `repository` |
| `@nodrail/triage-issues`      | A `triage` agent may read issues, comment and label. It can't close, assign, edit code or open pull requests.                                                                                | `repository` |
| `@nodrail/dependency-updates` | A `deps` agent may write lockfiles and refresh them with scripts off. Changes to package.json, commits and pushes wait for a person. It may open a draft pull request after the checks pass, and can't merge or force-push. | `repository` |
| `@nodrail/read-only`          | The `read-only` starter pack as a module.                                                                                                                                                    | None         |

`repository` is one exact repository, as `owner/name`. A wildcard or a path is refused.

A module that has values to give is reported as `configuration required` until it has them, and `export --frozen` refuses until then.

## Compose with your own files

Add your own rules files next to modules:

```sh
nodrail add ./policies/team.yaml
```

Imports compile in the order `nodrail.yaml` lists them, and `add` appends to the end. Order matters in one way only: a later file can change an entry from an earlier file with `override`. It doesn't change precedence. Deny still wins over review, and review over allow, whatever the order.

Names must be unique across every imported file. Redefining a module's rule or gate without `override` is an error, so a local file can't quietly weaken it.

### Example: one more reviewer

To make `@nodrail/open-reviewed-pr` also wait for a `security` agent, save this as `policies/security.yaml`:

```yaml
# Opening also waits for a security review of the same candidate.
- required_engine_version: 3
- gate: Require QA, checks and review on the candidate
  requires:
    - { agent: security, verdict: pass, since: [dev] }
  override: { requires: append }
```

The gate's name is the module's own. `override: { requires: append }` adds the requirement to the module's three. Add the file after the module and review the change:

```sh
nodrail add ./policies/security.yaml
```

```text
Added ./policies/security.yaml
Changed: nodrail.yaml, nodrail.lock.yaml
Permissions:
  1 permission change.

  Agent github
    github.pr.open
      repository exact "acme/widgets"
          needs review  gate reviewed-draft "Require QA, checks and review on the candidate": requires security: pass since dev
                        security's commands no longer count as changing the work for the other requirements
```

The same `override` can replace a field, such as `otherwise`, or append to a rule's `condition` or `tags`. A replacement can weaken a module's deny or gate: the review marks it `!`. See [Layering files](../../policy-engine/docs/rules.md#layering-files) for every form.

## Activate an export

Agents follow a playbook only through an enforcement point that reads the export. Which one depends on the calls the playbook covers.

**File and shell rules** work with the local Claude Code hook today. That covers `@nodrail/read-only` and the file part of `@nodrail/dependency-updates`. Point the hook from [Try APF locally](../../policy-engine/docs/getting-started.md#connect-claude-code) at the export:

```sh
nodrail policy hook effective.apf.yaml
```

`nodrail-policy hook effective.apf.yaml` does the same. The hook blocks any call no rule covers, so the export needs rules for every shell and file call your agent makes. Import those with the module, such as your own rules file or `@nodrail/read-only`, rather than loading a second file next to the export.

**GitHub rules** describe calls with tool `github`, operations such as `pr.open`, `pr.merge` or `issues.comment`, and resource kind `repository` with the id `owner/name`, as in the [APF guide](https://nodrail.com/docs/apf). They take effect only where an adapter maps your agents' GitHub calls to those names and supplies the run evidence the gates need: which candidate or head is being acted on, and the verdicts of QA, the checks and review for it. The local Claude Code hook doesn't map GitHub calls. An agent's own GitHub credentials don't go through these rules at all, so the merge and triage modules deny those agents the shell, where `gh` and `git push` would run. See [Runs, gates and budgets (preview)](../../policy-engine/docs/runs.md) for the evidence a gate reads.

## Limits

- **Nothing runs until you activate an export.** `add`, `lock` and `export` change files and print text. They install no hook and govern no agent.
- **A module is only as good as its enforcement point.** A GitHub module's guarantees cover the calls that go through a trusted adapter, with evidence that adapter supplies. Calls that bypass it aren't seen.
- **Agent names are reported, not authenticated.** `github`, `merger` or `triage` are the names your integration gives the caller. Read [the security model](../../policy-engine/docs/security-model.md) before relying on them.
- **Gates need engine level 3**, which is a preview. Receipts are self-reported: a gate proves a step reported a verdict, not that the work was good.
- **With the local hook, checkers vouch for themselves.** A session's agent name comes from the hook's `--agent` flag, so every subagent in that session shares it, and a verdict is whatever the checker's last message said. The modules stop the gated roles (`github`, `merger`, `deps`) from starting their own checkers, but a guarantee that QA, the checks and review really ran on the candidate needs an adapter that collects that evidence on the host, outside the agent's reach.
- **Protect the policy itself.** Agents shouldn't be able to edit `nodrail.yaml`, `nodrail.lock.yaml`, the files they import, or the exported policy. The `repo-work` starter pack protects the first two; `nodrail policy lock` compares with the lock as last committed in git, so a change an agent made and locked shows up in the review.
- **The lock covers files, not people.** It proves the export matches what was committed. Who may change `nodrail.yaml`, the lock and the deployed export is up to your repository's review rules. Keep them out of the agent's reach.
- **The catalog comes with `nodrail`.** The modules you can add are the ones bundled in your installed version. There is no registry, and nothing is downloaded.
