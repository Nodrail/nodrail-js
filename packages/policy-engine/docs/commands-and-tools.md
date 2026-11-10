# Commands and tools

Every call is described as a tool, an operation and a resource, and rules match on those.

| Call                                                       | `tool`        | `operation`                | `resource.kind` |
| ---------------------------------------------------------- | ------------- | -------------------------- | --------------- |
| Simple command                                             | `shell`       | `command.run`              | `command`       |
| Chain, pipe, substitution, `FOO=1 cmd`, `sudo`, `bash -c`… | `shell`       | `command.compound`         | `command`       |
| Command containing a secret                                | `shell`       | `command.redacted`         | `command`       |
| File read or search                                        | `files`       | `file.read`, `file.search` | `file`          |
| File write or edit                                         | `files`       | `file.write`, `file.edit`  | `file`          |
| File delete (Codex)                                        | `files`       | `file.delete`              | `file`      |
| Patch of several files, or a rename (Codex)                | `files`       | `file.patch`               | `file`      |
| Notebook edit                                              | `files`       | `notebook.edit`            | `file`          |
| Fetch or search                                            | `web`         | `fetch`, `search`          | `url`, `query`  |
| MCP tool                                                   | server name   | tool name                  | `mcp_tool`      |
| Any other Claude Code tool                                 | `claude-code` | tool name, lowercase       | `tool`          |

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
  items: [git status, git diff]

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

## Files

Paths are made absolute, then symlinks are followed and the disk's own casing is used, so `src/../.env` and `.ENV` on a case-insensitive disk are judged as the real file.

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

A file rule covers calls to file tools. It can't stop an allowed shell command from printing the same file, and a search is judged by the folder it starts in.

## Secrets

Likely credentials are removed from commands, URLs and MCP inputs before they are recorded. This is best effort.

A command with something removed becomes `command.redacted`, and its resource carries a fingerprint of the original. A rule written for what's visible can't cover a different hidden value. Very long commands are shortened and handled the same way.
