# Changelog

## 0.2.0

Gates, budgets and receipts. Engine level 3.

### Breaking

- Starting a Claude Code subagent (`Agent`, and `Task`, its earlier name) is
  described with the subagent's type as resource `{ kind: agent, id: <type> }`
  instead of `{ kind: tool, id: Agent }`. A rule for `tool: claude-code`,
  `operation: agent` with resource kind `tool` is now a compile error that
  points to
  [Upgrading rules for subagents](docs/runs.md#upgrading-rules-for-subagents),
  instead of quietly never matching.
- A file with gates or budgets compiles to document `version: 2`, which
  earlier engines reject. `validate` reports what the files compiled to, such
  as `OK, compiled to 150 rules, 2 gates and 1 budget.`, instead of
  `OK: N rules.` The counts are compiled entries: a command prefix rule
  compiles to two.
- The hook's run key is `NODRAIL_RUN`, else `<repo>/<branch>` (the `origin`
  remote as host/owner/name, with no credentials, or the repository folder's
  name), pinned to the Claude Code session by its first event, so switching
  branch doesn't change the run. On the default branch, a detached HEAD or
  outside git it is `session:<id>`.
- A budget that covers an action decided with no run applies its `otherwise`,
  as a gate with no history holds. `eval`, `check` and `exec` decide with no
  run, so they hold too.

Upgrading: change rules for starting a subagent to the new resource.

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

### Added

- `gate` entries: an action that matches waits until named steps started and
  finished with accepted verdicts after the last work, otherwise `deny` or
  `require_approval`. A gate never allows on its own. Work is anything the
  `since` agents did, and any change by another agent than the one required:
  files written, edited, patched or deleted, and shell commands other than
  the read-only pack's look-around ones.
- `isChange(descriptor)` from the main entry says whether an action is such a
  change; action events take `change: true`. Old events without it are not
  changes.
- `budget` entries: tool calls per step or run, tokens and dollars per run,
  with a warning level.
- `simulate()` takes the run's history and reports gates, budgets and
  warnings with every decision.
- `parseReceipt()` and `receiptBlock()` in `@nodrail/policy-engine/receipts`
  read the receipt an agent ends its step with. They read only the last 16 KB
  of a message, and a block over `MAX_RECEIPT_TEXT` (8192 characters) is no
  receipt, as in Cloud.
- `legacySubagentRuleProblem()` from the main entry, the compile check above
  for a rule form.
- `renderPolicies()` keeps gates and budgets.
- `nodrail-policy hook` keeps a run ledger when the rules have gates or
  budgets: steps from `SubagentStart` and `SubagentStop`, receipts from the
  last message, every decided action. One JSON Lines file per run in the
  repository's git folder, with session pins next to it. Each decision reads,
  decides and records under a lock file; a call that waits over 5 seconds is
  blocked. A last line cut off mid-write is left out. Rules without gates or
  budgets never touch it.
- `nodrail-policy hook` denies any file tool change to the rule files and
  folders it loaded, before reading the rules.
- `nodrail-policy runs`, `runs show <run>` and `runs report`.
- `@nodrail/policy-engine/hook-runs`: `runKey()`, `receiptBlock()`,
  `MAX_RECEIPT_TEXT` and `agentName()` for hooks that report runs elsewhere,
  with no zod or YAML.
- Cases files take `run` and `step`, so gates and budgets can be tested in CI.
  `{ action: <agent>, command: <line> }` records a command; a `finished` with
  no open step records a whole step.
- A decision held by a used-up budget says so: "Budget … is at 61 of 60 tool
  calls. Over the limit, …".

### Changed

- Problems in rule files point at what is wrong: an unknown key (`efect:`)
  at that key, a bad value, also inside `requires` or `resource`, at that
  value, a duplicate at its name or `id`, an unknown list at where it is
  named, `required_engine_version` at its value, and an item appended by an
  override in the file that appended it. They were at the start of the entry,
  some at column 1. Only `line` and `column` change; an issue has just
  `file`, `line`, `column` and `message`.
- Gates and budgets only make the rules' decision stricter. An action no
  rule covers stays blocked when an unmet gate or used-up budget only asks
  for a review.
- Both starter packs allow starting a Claude Code subagent. What it then does
  is still decided call by call.
- Both starter packs deny running `nodrail-policy` and `nodrail-claude-hook`
  from the shell. `repo-work` sends writes to `.npmrc` to a person.

## 0.1.5

No changes to the engine; released with `@nodrail/client` 0.1.5. Tests now
fail if coverage drops.

## 0.1.4

Fixes from a third independent review.

- Names are compared without regard to case, even for folders that don't exist
  yet: on many disks `.CLAUDE` is `.claude`, so a deny on `.claude` now holds.
- The `.env` family is recognised whatever its form (`.env-prod`, `prod.env`),
  and key files by extension (`*.pem`, `*.key`, `*.p12`, `*.pfx`).
- More places credentials live: `/proc/*/environ`, Claude Code's and Codex's
  sign-in files, Nodrail's own credential, and `.git/config`.
- A command argument with a wildcard or different case that could name a
  secret (`'.e*'`, `.en?`, `./.ENV`) makes the command never simple.
- A search of the home folder, or above it, counts as reaching secrets.
- `repo-work`: changes to `package.json`, makefiles and similar go to a person,
  and npm, pnpm and yarn flags that swap the shell or config make a command
  never simple. Its summary says plainly that tests run code the agent wrote.
- Redaction catches Stripe, GitLab, Google and npm keys, and names such as
  `OPENAI_KEY`.
- New: `reachesSecret()` and `SECRET_PLACES` decide secret reads the way the
  starter packs do.

## 0.1.3

Fixes from a second independent review. Upgrade if you use the starter packs.

- The starter packs hold better:
  - `repo-work` allows writing only inside the folder the agent works in, and
    denies `.gitconfig`, `.husky`, `.mcp.json`, `.vscode`, `.ssh` and
    `LaunchAgents` as well as `.git`, the agents' settings and shell start-up
    files. Writing `~/.gitconfig` could make an allowed `git status` run code.
  - `read-only` denies searches whose file pattern could pick out a secret
    (`.env*`, `*env`, `{.env,x}`), and more places credentials live
    (`.envrc`, `.git-credentials`, `.pgpass`, SSH key files, `gh` tokens).
- A dot file with a suffix answers to its base: `.env.staging` contains `.env`.
- A command that names a place credentials live, such as
  `git log -p -- .env`, is never simple, so an allowed prefix doesn't cover it.
- New params for file calls: `inside_cwd`, and `reaches_secrets` for searches.
- Resolving a very deep path took quadratic time. Paths are now limited to
  4,096 characters and 256 levels, and resolved in linear time. A patch of
  more than 1,000 files can't be described, so a person reviews it.

## 0.1.2

Security fixes found by an independent review. Upgrade if you rely on the
starter packs or on redaction.

- Reading what an agent wrote now takes linear time. A crafted command of a few
  hundred kilobytes could take minutes to describe, which in Codex would let the
  tool run when the hook timed out.
- A known token joined to other text by the shell, such as `0'ghp_…'`, is now
  redacted.
- A search is judged by every path it can reach: `Glob /home/me/.ssh/*` and
  Grep's `glob` now count as searching that folder.
- The starter packs deny reading or searching more places where credentials
  live (`.env.*`, `.gnupg`, `.kube`, `.docker`, `.npmrc` and others), no longer
  allow `git diff` or `git show` with arguments, and in `repo-work` deny writing
  to `.git`, `.claude`, `.codex` and shell start-up files.
- More commands that run other code are never simple: `git clone -u`,
  `--config` and `--template`, `--compress-program`, `zip -TT`, `man -P`,
  `pkexec`.
- New: `{ field, op: contains, list }` matches any item of a list. Files that
  use it declare `required_engine_version: 2`.
- Types now work with `moduleResolution: nodenext`.

## 0.1.1

The first version published from GitHub Actions, with npm provenance: each
release can be traced to the commit and workflow that built it. No code changes.

## 0.1.0

First public version: the evaluator, YAML rule files with lists, macros and layering, command and tool rules, the `nodrail-policy` command line, and the Claude Code hook.
