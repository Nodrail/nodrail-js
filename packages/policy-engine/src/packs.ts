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
# into the run ledger, so they are for you, not the agent. Starting the plugin
# hook through node or npx runs another program, which no rule here allows.
- list: nodrail_commands
  items: [nodrail-policy, nodrail-claude-hook]

- rule: Never run Nodrail itself
  command: { list: nodrail_commands, match: prefix }
  effect: deny

# Claude Code's own tools that only plan or talk to the person.
- rule: Keep a task list
  tool: claude-code
  operation: todowrite
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
# allowed npm test or make does, so a person reviews it.
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

- rule: A person reviews script writes
  tool: files
  operation: file.write
  resource: { kind: file, match: any }
  condition:
    - { field: path_parts, op: contains, list: script_places }
  effect: require_approval

- rule: A person reviews script edits
  tool: files
  operation: file.edit
  resource: { kind: file, match: any }
  condition:
    - { field: path_parts, op: contains, list: script_places }
  effect: require_approval

- rule: A person reviews workflow writes
  tool: files
  operation: file.write
  resource: { kind: file, match: any }
  condition:
    - { field: path_parts, op: contains, value: .github }
  effect: require_approval

- rule: A person reviews workflow edits
  tool: files
  operation: file.edit
  resource: { kind: file, match: any }
  condition:
    - { field: path_parts, op: contains, value: .github }
  effect: require_approval

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

- rule: A person reviews pushes
  command: { prefix: git push }
  effect: require_approval

- rule: Never force push
  command: { prefix: git push --force }
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
      "Also edits, tests and commits inside the project. Pushes and changes to build scripts go to a person. Tests run code the agent can write.",
    text: readOnlyRules + repoWorkRules,
  },
} as const satisfies Record<string, StarterPack>;

export type StarterPackName = keyof typeof starterPacks;
