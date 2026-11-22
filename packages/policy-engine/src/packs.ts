import { SECRET_PAIRS, SECRET_PLACES } from "./secrets.ts";

/**
 * Commands that only look at things, allowed with any arguments. Not git diff
 * or git show: given a path or a revision they print any file, secrets
 * included. Runs use these too: running one is not a change.
 */
export const LOOKING_COMMANDS = ["cd", "ls", "git status", "git log"] as const;

/** Commands that only look at things, allowed exactly as written. */
export const EXACT_LOOKING_COMMANDS = [
  "pwd",
  "git branch",
  "git diff",
  "git diff --staged",
] as const;

// Quoted: *.pem would otherwise read as a YAML alias.
const yamlList = (items: readonly string[]) =>
  items.map((item) => `    - ${JSON.stringify(item)}`).join("\n");

// A folder and a file name that together mean a token, for reads and searches.
const pairRules = SECRET_PAIRS.flatMap(({ label, parts }) =>
  (["read", "search"] as const).map(
    (verb) => `- rule: Never ${verb} ${label}
  tool: files
  operation: file.${verb}
  resource: { kind: file, match: any }
  condition:
${parts.map((part) => `    - { field: path_parts, op: contains, value: ${JSON.stringify(part)} }`).join("\n")}
  effect: deny
`,
  ),
).join("\n");

/** Starting points, written the way a team would write its own rules. */
const readOnlyRules = `- required_engine_version: 2

# Where credentials live. Reading or searching any of these is denied, and
# deny beats allow, so this holds whatever else is added. A dot file with a
# suffix counts as its base: .env.staging is .env.
- list: secret_places
  items:
${yamlList(SECRET_PLACES)}

- rule: Never read secrets
  tool: files
  operation: file.read
  resource: { kind: file, match: any }
  condition:
    - { field: path_parts, op: contains, list: secret_places }
  effect: deny

- rule: Never search secrets
  tool: files
  operation: file.search
  resource: { kind: file, match: any }
  condition:
    - { field: path_parts, op: contains, list: secret_places }
  effect: deny

# A file pattern such as .env* or *env picks out a secret without naming it.
- rule: Never search with a pattern that reaches secrets
  tool: files
  operation: file.search
  resource: { kind: file, match: any }
  condition:
    - { field: reaches_secrets, op: eq, value: true }
  effect: deny

${pairRules}
# Reading and searching the project.
- rule: Read files
  tool: files
  operation: file.read
  resource: { kind: file, match: any }
  effect: allow

- rule: Search files
  tool: files
  operation: file.search
  resource: { kind: file, match: any }
  effect: allow

# Commands that only look at things. Not git diff or git show: given a path or
# a revision they print any file, secrets included.
- list: looking_commands
  items: [${LOOKING_COMMANDS.join(", ")}]

- rule: Look around
  command: { list: looking_commands, match: prefix }
  effect: allow

- list: exact_looking_commands
  items: [${EXACT_LOOKING_COMMANDS.join(", ")}]

- rule: Where am I
  command: { list: exact_looking_commands }
  effect: allow

# Nodrail's own commands. Run by hand, the hook could write a step or a verdict
# into the run ledger, and \`nodrail\` can change the policy itself, so they are
# for you, not the agent. Starting the plugin hook through node or npx runs another
# program, which no rule here allows.
- list: nodrail_commands
  items: [nodrail, nodrail-policy, nodrail-claude-hook]

- rule: Never run Nodrail itself
  command: { list: nodrail_commands, match: prefix }
  effect: deny

# Claude Code's own tools that only plan or talk to the person.
- rule: Keep a task list
  tool: claude-code
  operation: todowrite
  resource: { kind: tool, match: any }
  effect: allow

# Claude Code's task tools, and the search that loads deferred tools such as
# these. A tool it loads is still decided call by call when it is used.
- rule: Load tools by search
  tool: claude-code
  operation: toolsearch
  resource: { kind: tool, match: any }
  effect: allow

- rule: Create a task
  tool: claude-code
  operation: taskcreate
  resource: { kind: tool, match: any }
  effect: allow

- rule: Update a task
  tool: claude-code
  operation: taskupdate
  resource: { kind: tool, match: any }
  effect: allow

- rule: List tasks
  tool: claude-code
  operation: tasklist
  resource: { kind: tool, match: any }
  effect: allow

- rule: Read a task
  tool: claude-code
  operation: taskget
  resource: { kind: tool, match: any }
  effect: allow

- rule: Ask the person a question
  tool: claude-code
  operation: askuserquestion
  resource: { kind: tool, match: any }
  effect: allow

- rule: Plan before acting
  tool: claude-code
  operation: enterplanmode
  resource: { kind: tool, match: any }
  effect: allow

- rule: Present a plan
  tool: claude-code
  operation: exitplanmode
  resource: { kind: tool, match: any }
  effect: allow

# Starting a subagent. What the subagent then does is decided call by call,
# like the main agent. Narrow this to the types you use, or gate one.
- rule: Start subagents
  tool: claude-code
  operation: agent
  resource: { kind: agent, match: any }
  effect: allow
`;

const repoWorkRules = `
# Changing the project, and only the project: a file outside the folder the
# agent works in isn't allowed, so it goes to a person.
- rule: Write files
  tool: files
  operation: file.write
  resource: { kind: file, match: any }
  condition:
    - { field: inside_cwd, op: eq, value: true }
  effect: allow

- rule: Edit files
  tool: files
  operation: file.edit
  resource: { kind: file, match: any }
  condition:
    - { field: inside_cwd, op: eq, value: true }
  effect: allow

# Files that change what runs next, or that turn the checks off: git's own
# hooks and config, commit hooks, the agents' and editors' settings, SSH keys,
# login agents, and shell start-up files.
- list: control_places
  items:
    - .git
    - .gitconfig
    - .husky
    - .claude
    - .codex
    - .mcp.json
    - .vscode
    - .ssh
    - LaunchAgents
    - .bashrc
    - .bash_profile
    - .profile
    - .zshrc
    - .zprofile
    - .zshenv
    # Nodrail's own project files: the policy the agent is held to.
    - nodrail.yaml
    - nodrail.lock.yaml
    - .nodrail

- rule: Never write control files
  tool: files
  operation: file.write
  resource: { kind: file, match: any }
  condition:
    - { field: path_parts, op: contains, list: control_places }
  effect: deny

- rule: Never edit control files
  tool: files
  operation: file.edit
  resource: { kind: file, match: any }
  condition:
    - { field: path_parts, op: contains, list: control_places }
  effect: deny

# What the everyday commands below run. Changing it would change what an
# allowed npm test or make does, so the agent can't: add a dependency or a
# script yourself, or drop these two rules if you trust the agent with what
# your tests run.
- list: script_places
  items:
    - package.json
    - pnpm-workspace.yaml
    - Makefile
    - makefile
    - GNUmakefile
    - justfile
    - Taskfile.yml
    - node_modules
    - .npmrc

- rule: Never write build scripts
  tool: files
  operation: file.write
  resource: { kind: file, match: any }
  condition:
    - { field: path_parts, op: contains, list: script_places }
  effect: deny

- rule: Never edit build scripts
  tool: files
  operation: file.edit
  resource: { kind: file, match: any }
  condition:
    - { field: path_parts, op: contains, list: script_places }
  effect: deny

# .github holds the workflows CI runs with its secrets, and the files that
# decide who reviews a merge, so only you change them.
- rule: Never write workflows
  tool: files
  operation: file.write
  resource: { kind: file, match: any }
  condition:
    - { field: path_parts, op: contains, value: .github }
  effect: deny

- rule: Never edit workflows
  tool: files
  operation: file.edit
  resource: { kind: file, match: any }
  condition:
    - { field: path_parts, op: contains, value: .github }
  effect: deny

# Everyday work. These run the project's own code, which the agent can also
# write, so allowing them trusts the agent with running code in this project.
# The denies below stop the agent doing these things directly, not through a
# script it wrote. See the security model.
- list: working_commands
  items:
    - git add
    - git commit
    - git switch
    - git stash
    - npm test
    - npm run lint
    - npm run build
    - pnpm test
    - pnpm lint
    - pnpm build

- rule: Everyday work
  command: { list: working_commands, match: prefix }
  effect: allow

# Pushing a feature branch is allowed when the push names its remote and
# branch, as in git push origin my-branch.
- rule: Push feature branches
  command: { prefix: git push origin }
  effect: allow

# Merging to main is yours, never the agent's: a push that names main or
# master is denied, and so is one that names no branch, which could push
# whatever is checked out, main included. A prefix matches whole words, so
# main-fix stays pushable.
- list: unnamed_pushes
  items:
    - git push
    - git push origin
    - git push origin HEAD

- rule: Never push without naming a branch
  command: { list: unnamed_pushes }
  effect: deny

- list: main_pushes
  items:
    - git push origin main
    - git push origin master
    - git push origin HEAD:main
    - git push origin HEAD:master
    - git push --all
    - git push --mirror

- rule: Never push to main
  command: { list: main_pushes, match: prefix }
  effect: deny

# A rule reads how a command starts, so these catch a force push whose flag
# comes first. Protect main on the remote as well: a flag at the end, or a
# refspec such as +feat or feat:main, isn't seen.
- list: force_pushes
  items:
    - git push --force
    - git push --force-with-lease
    - git push -f
    - git push origin --force
    - git push origin --force-with-lease
    - git push origin -f

- rule: Never force push
  command: { list: force_pushes, match: prefix }
  effect: deny

- rule: Never remove recursively
  command: { prefix: rm -rf }
  effect: deny
`;

export type StarterPack = { label: string; summary: string; text: string };

export const starterPacks = {
  "read-only": {
    label: "Read only",
    summary: "The agent can read and look around. Everything else is blocked.",
    text: readOnlyRules,
  },
  "repo-work": {
    label: "Repository work",
    summary:
      "Also edits, tests, commits and pushes feature branches. Pushes to main, force pushes, and changes to build scripts and workflows are denied. Tests run code the agent can write.",
    text: readOnlyRules + repoWorkRules,
  },
} as const satisfies Record<string, StarterPack>;

export type StarterPackName = keyof typeof starterPacks;
