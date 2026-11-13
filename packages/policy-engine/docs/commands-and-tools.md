# Commands and tools

This page explains how each call an agent makes is described, and how command and file rules match those descriptions.

Every call is described as a tool, an operation and a resource, and rules match on those.

| Call                                                       | `tool`        | `operation`                | `resource.kind` |
| ---------------------------------------------------------- | ------------- | -------------------------- | --------------- |
| Simple command                                             | `shell`       | `command.run`              | `command`       |
| Chain, pipe, substitution, `FOO=1 cmd`, `sudo`, `bash -c`… | `shell`       | `command.compound`         | `command`       |
| Command containing a secret                                | `shell`       | `command.redacted`         | `command`       |
| File read                                                  | `files`       | `file.read`                | `file`          |
| Search (Grep, Glob)                                        | `files`       | `file.search`              | `file`          |
| File write or edit                                         | `files`       | `file.write`, `file.edit`  | `file`          |
| File delete (Codex)                                        | `files`       | `file.delete`              | `file`      |
| Patch of several files, or a rename (Codex)                | `files`       | `file.patch`               | `file`      |
| Notebook edit                                              | `files`       | `notebook.edit`            | `file`          |
| Fetch or search                                            | `web`         | `fetch`, `search`          | `url`, `query`  |
| MCP tool                                                   | server name   | tool name                  | `mcp_tool`      |
| Starting a Claude Code subagent (`Agent`, or `Task`)       | `claude-code` | `agent`                    | `agent`, id the subagent's type |
| Any other Claude Code tool                                 | `claude-code` | tool name, lowercase       | `tool`          |

The subagent's type is named the way runs name agents, so `vercel:deployment-expert` is `vercel-deployment-expert`. Rules written before engine level 3 described this call as resource `{ kind: tool, id: Agent }`; a rules file with such a rule is now refused: see [Upgrading rules for subagents (preview)](runs.md#upgrading-rules-for-subagents).

## Command rules

`command:` is shorthand for a rule on `tool: shell`.

```yaml
- rule: Exact command
  command: npm test
  effect: allow

- rule: With any arguments
  command: { prefix: git log }
  effect: allow

- list: safe_commands
  items: [git status, git log]

- rule: From a list
  command: { list: safe_commands, match: prefix }
  effect: allow
```

A prefix means whole words: `git log` covers `git log -1` but not `git logger`.

Spelling doesn't change a command. Quotes and repeated spaces are normalized first, so `g"i"t   log` is judged as `git log`.

## Chains

`cd app && pnpm test` is judged part by part. It is allowed only if every part is, and denied if any part is. A part that needs review sends the whole chain to review.

The whole line goes to `command.compound` when it uses substitution, redirects, background `&`, or a part that runs another program. Such a line only matches a rule written for it:

```yaml
- rule: Line count
  tool: shell
  operation: command.compound
  resource: { kind: command, match: exact, value: "ls | wc -l" }
  effect: allow
```

A rule on the whole line can vouch for parts nothing else covers, but it can't overrule a part's deny or review.

## What a prefix trusts

An allow on a prefix trusts that program with every argument it gets. The engine sends known risks to `command.compound`: programs that run other programs, flags such as `--output=` and `--upload-pack=`, and git options placed before the subcommand. That list can't be complete, and `npm test` runs whatever `package.json` says.

- Allow exact commands where you can.
- A deny prefix is easy to step around, because a flag can sit anywhere. Use it together with an allow list.
- Some read commands print any file they're pointed at: `git diff --no-index a b`, `git show HEAD:.env`, `cat`. Allow them exactly, without arguments, or not at all.

## Files

Paths are made absolute, then symlinks are followed and the disk's own casing is used, so `src/../.env` and `.ENV` on a case-insensitive disk are judged as the real file.

A search is judged by everywhere it can reach. Its resource is the folder it searches, narrowed by the fixed start of its file pattern, so `Glob /home/me/.ssh/*` is a search of `/home/me/.ssh`. Its `path_parts` also hold every part of the pattern, so `**/.env` contains `.env`.

To name a folder or file anywhere in a path, use `path_parts`:

```yaml
- rule: Never read SSH keys
  tool: files
  operation: file.read
  resource: { kind: file, match: any }
  condition:
    - { field: path_parts, op: contains, value: .ssh }
  effect: deny
```

A dot file with a suffix also answers to its base, so `.env.staging` and `.env.local` contain `.env`.

File calls carry these params:

| Param | What it is |
| --- | --- |
| `path` | The resolved path. Paths over 4,096 characters or 256 levels deep, and patches of more than 1,000 files, can't be described, so they're blocked |
| `path_parts` | Every folder and file name in the path, as above |
| `inside_cwd` | `true` when the path is inside the folder the agent works in. Missing when that folder isn't known, and a missing value never helps an allow |
| `reaches_secrets` | Searches only: `true` when the file pattern could pick out a place where credentials live, such as `.env*`, `*env` or `{.env,x}` |

A file rule covers calls to file tools. It can't stop an allowed shell command from printing the same file, which is why a command that names a place where credentials live, such as `git log -p -- .env` or `git show HEAD:.env`, is never a simple command: an allowed prefix doesn't cover it.

## Secrets

Likely credentials are removed from commands, URLs and MCP inputs before they are recorded. This is best effort.

A command with something removed becomes `command.redacted`, and its resource carries a fingerprint of the original. A rule written for what's visible can't cover a different hidden value. Very long commands are shortened and handled the same way.
