# Changelog

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
