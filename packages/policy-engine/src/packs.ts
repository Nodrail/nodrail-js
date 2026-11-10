/** Starting points, written the way a team would write its own rules. */
const readOnlyRules = `- required_engine_version: 1

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

# Deny beats allow, so these hold whatever else is added.
- rule: Never read .env
  tool: files
  operation: file.read
  resource: { kind: file, match: any }
  condition:
    - { field: path_parts, op: contains, value: .env }
  effect: deny

- rule: Never read .env.local
  tool: files
  operation: file.read
  resource: { kind: file, match: any }
  condition:
    - { field: path_parts, op: contains, value: .env.local }
  effect: deny

- rule: Never read SSH keys
  tool: files
  operation: file.read
  resource: { kind: file, match: any }
  condition:
    - { field: path_parts, op: contains, value: .ssh }
  effect: deny

- rule: Never read cloud credentials
  tool: files
  operation: file.read
  resource: { kind: file, match: any }
  condition:
    - { field: path_parts, op: contains, value: .aws }
  effect: deny

# Commands that only look at things.
- list: looking_commands
  items: [cd, ls, git status, git diff, git log, git show]

- rule: Look around
  command: { list: looking_commands, match: prefix }
  effect: allow

- list: exact_looking_commands
  items: [pwd, git branch]

- rule: Where am I
  command: { list: exact_looking_commands }
  effect: allow

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
`;

const repoWorkRules = `
# Changing the project.
- rule: Write files
  tool: files
  operation: file.write
  resource: { kind: file, match: any }
  effect: allow

- rule: Edit files
  tool: files
  operation: file.edit
  resource: { kind: file, match: any }
  effect: allow

# The hook lives here, so an agent must not be able to turn it off.
- rule: Never write Claude Code settings
  tool: files
  operation: file.write
  resource: { kind: file, match: any }
  condition:
    - { field: path_parts, op: contains, value: .claude }
  effect: deny

- rule: Never edit Claude Code settings
  tool: files
  operation: file.edit
  resource: { kind: file, match: any }
  condition:
    - { field: path_parts, op: contains, value: .claude }
  effect: deny

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

# Everyday work. These run the project's own scripts, so they trust them.
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
    summary: "Also edits, tests and commits. Pushes go to a person.",
    text: readOnlyRules + repoWorkRules,
  },
} as const satisfies Record<string, StarterPack>;

export type StarterPackName = keyof typeof starterPacks;
