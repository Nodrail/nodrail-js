# Compatibility, migration and limits (preview)

What a shared workspace (`nodrail.yaml` with hosts, agents and connections) has been shown to do, on which versions, and what it doesn't cover. "Verified live" means a real host session, signed in, from a packed `nodrail`. "Tested" means automated tests with stand-in hosts.

## Tested profile

| | Version | Evidence |
| --- | --- | --- |
| macOS | 27.2 | verified live, one machine; a second machine is pending |
| Node | 22.22.3 | verified live |
| Claude Code | 2.1.328 | verified live |
| Codex | 0.170.0 | verified live, folder and hook trusted |
| GitHub Copilot CLI | 1.0.114 | verified live with `--trust-folder` for one run; the default model only (this account can't choose Claude models) |
| `nodrail` | the build from source revision `8eae500` | packed and installed outside the repository |

On that profile, the support-desk example passed every check in the workspace acceptance list on both hosts:

- the lock records the workspace, and plan starts nothing;
- both hosts load the agents and the skill, and the hook is active;
- denied and held calls had no effect at the provider;
- updates, your own edits, concurrent applies, rollback and secrets all behaved as described.

The example's `nodrail.yaml` names these versions under `tested:`. Other versions aren't refused: `plan` marks them `?`, unverified. The minimums are still enforced: Claude Code 2.1.295 and Codex 0.169.0. Windows runs the automated tests for Claude Code only; Codex on Windows isn't set up.

## What each host proves

| | Claude Code | Codex | Copilot CLI |
| --- | --- | --- | --- |
| Policy hook active | `configured`: the hook is in `.claude/settings.json` and no settings file turns hooks off. Claude Code can't be asked which hooks it runs. | `verified`: Codex says it runs nodrail's hook, after you trust the folder and the hook. | `configured`: the hook is in `.github/hooks/nodrail.json` and the folder is in your trusted folders. Copilot can't be asked which hooks it runs. |
| A rule that needs a person's review | Held: Claude Code asks you. | Denied with the reason: Codex can't ask. | Denied with the reason: Copilot's hook can't ask. |
| Who called | The hook gets the agent from the host, for subagents too. Text an agent writes ("I am support") changes nothing. | Same, with Codex's agent role. | The session's `--agent`; Copilot doesn't name the agent per call, so a subagent's calls are judged as the entry agent's. |
| Skills | Each member may load the skills its Agent lists. | Codex reads the skill files itself; the file rules decide. | Copilot reads `.github/skills` itself; the file rules decide. |
| Tool connections | `mcp__<name>__<tool>` | `mcp__<name with _ for ->__<tool>`, read as the same connection | `<name>-<tool>` in `.github/mcp.json`, read as the same connection (verified live). |
| Session-start observation | Runs at each session start once the folder is trusted. | Runs once you trust the new hook in `/hooks`; until then `status` says so. The policy hook stays trusted. | Runs at each session start in a trusted folder (verified live). |
| Plugins in the project | Loaded once the folder is trusted; nothing installed. Tools `mcp__plugin_<plugin>_<server>__<tool>`. | Listed once the folder is trusted; loaded after the person runs `codex plugin add`, which enables it for every folder. Tools `mcp__<server>__<tool>`. | Not set up yet: `plan` says so. |

## Enforcement matrix

What the policy hook sees and how each host behaves when it can't run. Verified live unless marked.

| | Claude Code | Codex | Copilot CLI |
| --- | --- | --- | --- |
| Shell commands | yes | yes | yes (`bash`) |
| File reads and edits | yes | yes, through the shell and `apply_patch` | yes (`view`, `create`, `edit`; `apply_patch` judged per file) |
| MCP tools | yes | yes | yes |
| Starting a subagent | yes | yes | yes (`task`); the subagent's own calls not observed yet |
| If the hook can't run | blocked (`onFailure: block`) | blocked (the shell answers deny) | blocked (a failing hook denies); a hook timeout lets the call through, so the hook keeps to 20 s |
| A review | asks you | denied | denied |
| Trust step | trust the folder | trust the folder and the hook in `/hooks` | trust the folder |
| Switched off by | `disableAllHooks`, managed hooks only | `requirements.toml` (`?`) | `disableAllHooks` in `.github/copilot/settings*.json`, `.claude/settings*.json` or `~/.copilot/settings.json` (`plan` shows `!`) |

Copilot also runs a project's Claude Code hooks, with Claude Code's tool names and its own arguments. nodrail's Claude Code hook reads such a call as Copilot's (`COPILOT_HOOK_DEPTH`), so a project set up only for Claude Code stays guarded when someone opens Copilot in it (verified live).

## An administrator's settings

An organization can turn off, on a machine, what a project sets up. `plan` reads what it can and marks what wouldn't load, before `apply`:

| | Read | `plan` says |
| --- | --- | --- |
| Claude Code `managed-settings.json` and `managed-settings.d/*.json` | yes, merged as Claude Code merges them | `!` for a connection that `deniedMcpServers` or `disabledMcpjsonServers` names, or that `allowedMcpServers` doesn't (by name or exact command line, verified live); for all of them under `managed-mcp.json` or `strictPluginOnlyCustomization` with `mcp`; for the project's marketplace when `blockedMarketplaces` names its folder or `strictKnownMarketplaces` doesn't (`directory` or `pathPattern`); for a plugin managed `enabledPlugins` turns off; for agents or skills kept to plugins; for another `agent` forced. The hook is `inactive` with `disableAllHooks`, `allowManagedHooksOnly` or hooks kept to plugins. |
| Codex `requirements.toml` | the tables and a few keys, without the full semantics | `?` for a connection when it lists MCP servers but not this one, and for plugins when `[features] plugins = false` or `restrict_to_allowed_sources = true`. Whether Codex runs the hook is asked of Codex. |
| macOS configuration profiles (`/Library/Managed Preferences`), Claude Code's server-managed settings, Windows registry | no | `?` when a profile for the host is there; server-managed settings and the registry can't be seen. |

## Migration

- **Lock format 2.** A project with a setup moves from `lock: 1` to `lock: 2`, which records the workspace. Until you run `nodrail policy lock`, `plan` says so and `apply` waits; `policy export --frozen` keeps working. A project with only a policy stays at `lock: 1`. An older `nodrail` refuses `lock: 2` with a message.
- **New Team rules.** Teams now let each member load its own skills, which adds one allow per member and skill. Run `nodrail policy lock` to review and record them.
- **The workspace digest** covers the effective policy too, so a setup's lock changes once more. Run `nodrail policy lock` again.
- **`plan --json`** keeps `ready` and `active`, and adds `activation`, `revision` and `applied`. The exit code still means "apply could go ahead". `--require-active` is the opt-in that also requires the policy to be enforced.
- **`tested:`** is a proposed field: its name and shape may still change.

## Limits

- **The shell.** A policy that allows any shell command gives up these guarantees: a command can write any file. The hook judges the shell forms it knows, and blocks commands that name the setup's files. It doesn't block a command that acts on the whole project, such as `git checkout .`.
- **Other routes.** The hook decides the tool calls the host sends through it. A tool the host runs without the hook, or a program an allowed command starts, isn't covered.
- **What nodrail manages.** Only the files and settings nodrail wrote, as recorded in `.nodrail/setup-state.json`. Your own skills, plugins, MCP servers and settings are kept, but `plan` doesn't list them, and they aren't part of the workspace revision.
- **Data.** What connections read and write, such as a handbook folder, an outbox or a memory file, isn't in the revision and isn't locked. Removing a connection leaves its data. Data a connection declares under `data` is kept from file tools and from shell commands that name it; a command over the whole project folder, such as `grep -r x .`, still reaches it, as the shell limit above says.
- **Sessions already open** keep the agents, skills and settings they started with. The policy reaches them at their next tool call. `apply` says which applies.
