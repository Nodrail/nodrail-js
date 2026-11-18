import { describe, expect, test } from "vitest";
import { parse } from "yaml";
import { describeToolCall } from "../src/actions";
import { toDescriptor } from "../src/local-hook";
import { simulate } from "../src/simulator";
import {
  compilePolicies,
  renameAgents,
  resolveProject,
  type Catalog,
} from "../src/yaml";
import { memoryHost } from "./support/project-host";

// A playbook in the catalog's style: its rules name roles, not your agents.
const review = `- rule: The publisher opens drafts
  id: open
  agent: github
  tool: github
  operation: pr.open
  resource: { kind: repository, match: any }
  effect: allow

- rule: The publisher never starts qa
  id: no-start-qa
  agent: github
  tool: claude-code
  operation: agent
  resource: { kind: agent, match: exact, value: qa }
  effect: deny

- gate: Checked before opening
  id: checked
  agent: github
  tool: github
  operation: pr.open
  resource: { kind: repository, match: any }
  requires:
    - { agent: qa, verdict: pass, since: [dev] }
  otherwise: deny
`;

const catalog: Catalog = [
  {
    id: "@nodrail/review",
    version: "1.0.0",
    files: {
      "module.yaml": `kind: nodrail.module/v1
imports: [review.yaml]
roles:
  github: Opens the draft.
  qa: Tests it.
`,
      "review.yaml": review,
    },
  },
];

const api = "apiVersion: apf.nodrail.com/v1alpha1";
const agent = (name: string, spec = "{}") =>
  `${api}\nkind: Agent\nmetadata: { name: ${name} }\nspec: ${spec}\n`;
const team = (name: string, spec: string) =>
  `${api}\nkind: Team\nmetadata: { name: ${name} }\nspec: ${spec}\n`;
const binding = (name: string, spec: string) =>
  `${api}\nkind: PolicyBinding\nmetadata: { name: ${name} }\nspec: ${spec}\n`;
const docs = (...items: string[]) => items.join("---\n");

const marketing = team(
  "marketing",
  "{ entry: editor, members: [editor, publisher, tester, builder], handoffs: [{ from: editor, to: publisher }] }",
);
const agents = ["editor", "publisher", "tester", "builder"].map((name) =>
  agent(name),
);
const roles =
  "{ policy: '@nodrail/review', roles: { github: publisher, qa: tester, dev: builder } }";

const project = (
  setup: string,
  files: Record<string, string> = {},
  links: Record<string, string | undefined> = {},
) =>
  resolveProject({
    host: memoryHost(
      { "nodrail.yaml": `kind: nodrail.project/v1\n${setup}`, ...files },
      links,
    ),
    catalog,
  });

const messages = (result: ReturnType<typeof resolveProject>) =>
  result.problems.map((problem) => problem.message);

const withReview = (resources: Record<string, string>, extra = "") =>
  project(
    `runtime: claude-code\nresources: ./resources\nimports: ["@nodrail/review"]\n${extra}`,
    resources,
  );

describe("the setup nodrail.yaml declares", () => {
  test("reads a folder of resources, in order, and starts its only team", () => {
    const result = withReview({
      "resources/agents.yaml": docs(...agents),
      "resources/team.yaml": docs(marketing, binding("review", roles)),
      "resources/notes.txt": "not a resource",
    });
    expect(messages(result)).toEqual([]);
    expect(result.setup).toMatchObject({
      runtime: "claude-code",
      start: false,
      team: { name: "marketing", entry: "editor" },
      files: ["resources/agents.yaml", "resources/team.yaml"],
    });
    expect(result.setup.agents.map((each) => each.name)).toEqual([
      "editor",
      "publisher",
      "tester",
      "builder",
    ]);
    // The resources are locked like any other file the policy came from.
    expect(result.inputs.map((input) => input.path)).toContain(
      "resources/team.yaml",
    );
  });

  test("binding a module gives its roles to the team's agents", () => {
    const result = withReview({
      "resources/all.yaml": docs(
        ...agents,
        marketing,
        binding("review", roles),
      ),
    });
    expect(messages(result)).toEqual([]);
    const [source] = result.sources;
    expect(source?.text).toContain("agent: publisher");
    expect(source?.text).toContain("value: tester");
    expect(source?.text).toContain(
      "{agent: tester, verdict: pass, since: [builder]}",
    );
    // Only agent places change: the tool is still github, the titles as written.
    expect(source?.text).not.toMatch(
      /agent: (github|qa)|value: qa|since: \[dev\]/,
    );
    expect(source?.text).toContain("tool: github");
    expect(source?.text).toContain("never starts qa");
    // Comments and the rest of the file stay as written.
    expect(source?.text).toContain("- gate: Checked before opening");
    expect(compilePolicies(result.sources).ok).toBe(true);
  });

  test("an import nobody binds stays exactly as written", () => {
    const result = project(`imports: ["@nodrail/review"]\n`);
    expect(messages(result)).toEqual([]);
    const text = result.sources[0]?.text;
    expect(text).toContain("agent: github");
    expect(text).toContain("value: qa");
    expect(text).toContain("since: [dev]");
    expect(result.setup.team).toBeNull();
  });

  test("every agent a bound policy names needs someone to play it", () => {
    const result = withReview({
      "resources/all.yaml": docs(
        ...agents,
        marketing,
        binding(
          "review",
          "{ policy: '@nodrail/review', roles: { github: publisher, qa: tester, typo: editor } }",
        ),
      ),
    });
    expect(messages(result)).toEqual([
      "@nodrail/review names no role typo",
      "@nodrail/review names dev, which no agent plays; add dev to roles",
    ]);
  });

  test("one agent can't play two roles, nor a role off the team", () => {
    const result = withReview({
      "resources/all.yaml": docs(
        ...agents,
        agent("stranger"),
        marketing,
        binding(
          "review",
          "{ policy: '@nodrail/review', roles: { github: publisher, qa: publisher, dev: stranger } }",
        ),
      ),
    });
    expect(messages(result)).toEqual([
      "Role dev goes to stranger, who isn't on the team",
      "@nodrail/review's github and qa would both be publisher; one agent would vouch for itself",
    ]);
  });

  test("a role can't go to an agent the policy already names for another", () => {
    // qa is a member, so the policy's qa stays qa; github to qa merges them.
    const result = withReview({
      "resources/all.yaml": docs(
        ...agents,
        agent("qa"),
        team(
          "marketing",
          "{ entry: editor, members: [editor, publisher, tester, builder, qa] }",
        ),
        binding(
          "review",
          "{ policy: '@nodrail/review', roles: { github: qa, dev: builder } }",
        ),
      ),
    });
    expect(messages(result)).toEqual([
      "@nodrail/review's github and qa would both be qa; one agent would vouch for itself",
    ]);
  });

  test("a role named like an Object property is just a name", () => {
    const renamed = renameAgents("- rule: R\n  agent: constructor\n", {});
    expect(renamed.text).toContain("agent: constructor");
    expect(renamed.names).toEqual(["constructor"]);
  });

  test("a local Policy takes effect only through a binding, after the imports", () => {
    const rules = `- rule: Tester never publishes
  agent: checker
  tool: artifacts
  operation: artifact.publish
  resource: { kind: draft, match: any }
  effect: deny
`;
    const policy = `${api}\nkind: Policy\nmetadata: { name: local }\nspec: { source: ../policies/local.yaml }\n`;
    const bound = withReview({
      "policies/local.yaml": rules,
      "resources/all.yaml": docs(
        ...agents,
        marketing,
        binding("review", roles),
        policy,
        binding("local", "{ policy: local, roles: { checker: tester } }"),
      ),
    });
    expect(messages(bound)).toEqual([]);
    expect(bound.sources.map((source) => source.name)).toEqual([
      "@nodrail/review/review.yaml",
      "policies/local.yaml",
      "team/marketing.apf.yaml",
    ]);
    expect(bound.sources[1]?.text).toContain("agent: tester");

    const unbound = withReview({
      "policies/local.yaml": rules,
      "resources/all.yaml": docs(
        ...agents,
        marketing,
        binding("review", roles),
        policy,
      ),
    });
    expect(messages(unbound)).toEqual([
      "Policy local isn't bound, so it does nothing; add a PolicyBinding",
    ]);
    expect(unbound.sources).toHaveLength(2);
  });

  test("a policy is imported or bound, never both", () => {
    const result = project(
      `resources: ./resources/all.yaml\nimports: [./policies/local.yaml]\n`,
      {
        "policies/local.yaml": "[]\n",
        "resources/all.yaml": docs(
          agent("editor"),
          `${api}\nkind: Policy\nmetadata: { name: local }\nspec: { source: ../policies/local.yaml }\n`,
          binding("local", "{ policy: local }"),
        ),
      },
    );
    expect(messages(result)).toEqual([
      "Already imported unbound; import it or bind it, not both",
    ]);
  });

  test("a binding names a Policy or an imported module", () => {
    const result = project(`resources: ./r.yaml\n`, {
      "r.yaml": docs(
        agent("editor"),
        binding("a", "{ policy: missing }"),
        binding("b", "{ policy: '@nodrail/review' }"),
      ),
    });
    expect(messages(result)).toEqual([
      "No Policy named missing",
      "@nodrail/review isn't imported; add it to imports first",
    ]);
  });

  test("a team's entry, members and handoffs are its own agents", () => {
    const result = project(`resources: ./r.yaml\n`, {
      "r.yaml": docs(
        agent("editor"),
        team(
          "t",
          "{ entry: boss, members: [editor, ghost, editor], handoffs: [{ from: editor, to: editor }, { from: editor, to: outsider }] }",
        ),
      ),
    });
    expect(messages(result)).toEqual([
      "Lists a member twice",
      "No Agent named ghost",
      "Its entry boss isn't a member",
      "editor hands off to itself",
      "Hands off with outsider, who isn't a member",
    ]);
  });

  test("which team starts: the named one, the only one, or say which", () => {
    const two = docs(
      agent("editor"),
      team("a", "{ entry: editor, members: [editor] }"),
      team("b", "{ entry: editor, members: [editor] }"),
    );
    expect(
      messages(project(`resources: ./r.yaml\n`, { "r.yaml": two })),
    ).toEqual(["Say which team to start: team: <name>"]);
    expect(
      project(`resources: ./r.yaml\nteam: b\n`, { "r.yaml": two }).setup.team
        ?.name,
    ).toBe("b");
    expect(
      messages(project(`resources: ./r.yaml\nteam: c\n`, { "r.yaml": two })),
    ).toEqual(["No Team named c"]);
    expect(messages(project(`runtime: codex\n`))).toEqual([
      "codex needs a Team to start",
    ]);
  });

  test("resources are checked field by field, and named once per kind", () => {
    const result = project(`resources: ./r.yaml\n`, {
      "r.yaml": docs(
        agent("editor"),
        agent("editor"),
        agent("Editor"),
        agent("x", "{ prompt: hi }"),
        `apiVersion: apf.nodrail.com/v1\nkind: Agent\nmetadata: { name: y }\nspec: {}\n`,
        `${api}\nkind: Deployment\nmetadata: { name: z }\nspec: {}\n`,
      ),
    });
    expect(result.problems.map((p) => `${p.ref}: ${p.message}`)).toEqual([
      "editor: A second Agent named editor",
      expect.stringMatching(/^r\.yaml: metadata\.name: Lowercase letters/),
      expect.stringMatching(/^r\.yaml: spec: .*prompt/),
      expect.stringMatching(/^r\.yaml: apiVersion: /),
      expect.stringMatching(/^r\.yaml: kind: /),
    ]);
  });

  test("an agent's instructions and skills are files in the project", () => {
    const result = project(`resources: ./team/r.yaml\n`, {
      "team/editor.md": "# Editor\n",
      "team/skills/style/SKILL.md": "---\nname: style\n---\n",
      "team/r.yaml": docs(
        agent(
          "editor",
          "{ description: Edits drafts, instructions: ./editor.md, skills: [./skills/style/] }",
        ),
        agent("other", "{ instructions: ./none.md, skills: [./skills/none] }"),
        agent("climber", "{ instructions: ../../out.md }"),
      ),
    });
    expect(result.setup.agents[0]).toMatchObject({
      description: "Edits drafts",
      instructions: "team/editor.md",
      skills: ["team/skills/style"],
    });
    expect(result.problems.map((p) => `${p.ref}: ${p.message}`)).toEqual([
      "./none.md: No such file",
      "./skills/none: No SKILL.md in that folder",
      "../../out.md: The path leaves the project folder",
    ]);
  });

  test("a skill whose SKILL.md links out of the project is refused", () => {
    const result = project(
      `resources: ./r.yaml\n`,
      {
        "skills/leak/SKILL.md": "outside",
        "r.yaml": agent("editor", "{ skills: [./skills/leak] }"),
      },
      { "skills/leak/SKILL.md": undefined },
    );
    expect(result.problems.map((p) => `${p.ref}: ${p.message}`)).toEqual([
      "./skills/leak: The path leaves the project folder",
    ]);
    expect(result.setup.agents[0]?.skills).toEqual([]);
  });

  test("an agent's sources can't be where nodrail writes", () => {
    const result = project(`resources: ./r.yaml\n`, {
      ".claude/skills/review/SKILL.md": "mine",
      ".claude/agents/lead.md": "mine",
      "r.yaml": agent(
        "editor",
        "{ instructions: ./.claude/agents/lead.md, skills: [./.claude/skills/review] }",
      ),
    });
    expect(result.problems.map((p) => `${p.ref}: ${p.message}`)).toEqual([
      "./.claude/agents/lead.md: nodrail apply writes there, so it can't be a source; keep it in a folder of your own",
      "./.claude/skills/review: nodrail apply writes there, so it can't be a source; keep it in a folder of your own",
    ]);
  });

  test("a missing, broken or wrong resource or Policy file is a problem", () => {
    const policy = (name: string, source: string) =>
      `${api}\nkind: Policy\nmetadata: { name: ${name} }\nspec: { source: ${source} }\n`;
    const result = project(
      `resources: [./none.yaml, ./bad.yaml, ./r.yaml, ../out.yaml]\n`,
      {
        "bad.yaml": "a: [unclosed\n",
        "manifest.yaml": "kind: nodrail.project/v1\n",
        "r.yaml": docs(
          agent("editor"),
          policy("gone", "./gone.yaml"),
          binding("gone", "{ policy: gone }"),
          policy("manifest", "./manifest.yaml"),
          binding("manifest", "{ policy: manifest }"),
        ),
      },
    );
    expect(result.problems.map((p) => `${p.ref}: ${p.message}`)).toEqual([
      "./none.yaml: No such file or folder",
      expect.stringMatching(/^bad\.yaml: Not YAML: /),
      "../out.yaml: The path leaves the project folder",
      "gone.yaml: No such file",
      "manifest.yaml: A Policy's source is a rules file",
    ]);
    expect(result.sources).toEqual([]);
  });

  test("only nodrail.yaml declares the setup", () => {
    const result = project(`imports: [./more.yaml]\n`, {
      "more.yaml": "kind: nodrail.project/v1\nruntime: codex\n",
    });
    expect(messages(result)).toEqual(["Only nodrail.yaml says runtime"]);
  });
});

describe("renaming a policy's agents", () => {
  test("covers every place a rules file names an agent", () => {
    const text = `- budget: Steps
  step_agent: dev
  per: run
  tool_calls: 5
  otherwise: deny
- gate: G
  requires:
    - { agent: qa, verdict: pass, since: dev }
`;
    const renamed = renameAgents(text, { dev: "builder", qa: "tester" });
    expect(renamed.text).toContain("step_agent: builder");
    expect(renamed.text).toContain(
      "{agent: tester, verdict: pass, since: builder}",
    );
    expect(renamed.names.sort()).toEqual(["dev", "qa"]);
  });

  test.each(["null", "true", "123", "no"])(
    "an agent called %s stays a name, never a YAML null or number",
    (name) => {
      // `agent: null` would mean any agent: the rule would widen to everyone.
      const renamed = renameAgents(
        "- rule: R\n  agent: github\n  resource: { kind: agent, match: exact, value: qa }\n",
        { github: name, qa: name },
      );
      const [rule] = parse(renamed.text) as [
        { agent: unknown; resource: { value: unknown } },
      ];
      expect(rule.agent).toBe(name);
      expect(rule.resource.value).toBe(name);
    },
  );

  test("names given through a list can't be bound, and say so", () => {
    const renamed = renameAgents(
      `- rule: R
  resource: { kind: agent, list: checkers }
- gate: G
  requires: [{ agent: qa, verdict: pass, since: { list: devs } }]
`,
      {},
    );
    expect(renamed.problems).toEqual([
      "resource: { kind: agent, list } names agents through a list",
      "since: { list } names agents through a list",
    ]);
  });
});

describe("what a team means", () => {
  const result = project(`resources: ./r.yaml\n`, {
    "r.yaml": docs(
      ...agents,
      team(
        "release",
        "{ entry: editor, members: [editor, publisher, tester], handoffs: [{ from: editor, to: publisher }, { from: editor, to: tester }] }",
      ),
    ),
  });
  // An allow for everything, as a careless file might add: the team's denies
  // still win.
  const open = `- rule: Anything
  tool: claude-code
  operation: agent
  resource: { kind: agent, match: any }
  effect: allow
`;
  const compiled = compilePolicies([
    { name: "open.yaml", text: open },
    ...result.sources,
  ]);
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.issues));
  const decide = (
    agent: string,
    tool: string,
    input: Record<string, unknown>,
  ) => {
    const action = describeToolCall(tool, input);
    if (!action) throw new Error("not described");
    return simulate({
      document: compiled.document,
      descriptor: toDescriptor(action, { agent }),
      now: new Date("2026-11-18T00:00:00Z"),
    }).outcome;
  };
  const start = (agent: string, to: string) =>
    decide(agent, "Agent", { subagent_type: to, prompt: "go" });

  test("is one more file, last, that compiles", () => {
    expect(messages(result)).toEqual([]);
    expect(result.sources.map((source) => source.name)).toEqual([
      "team/release.apf.yaml",
    ]);
  });

  test("each member starts only the members it hands off to", () => {
    expect(start("editor", "publisher")).toBe("allow");
    expect(start("editor", "tester")).toBe("allow");
    expect(start("editor", "editor")).toBe("deny");
    expect(start("publisher", "tester")).toBe("deny");
    expect(start("tester", "editor")).toBe("deny");
  });

  // As Codex 0.169 sends them: its tool namespace in front, the handed-over
  // message encrypted.
  const codexStart = (agent: string, to?: string) =>
    decide(agent, "collaborationspawn_agent", {
      task_name: "t",
      ...(to ? { agent_type: to } : {}),
      message: "gAAAAB...",
    });

  test("the same holds when Codex starts the agent", () => {
    expect(codexStart("editor", "publisher")).toBe("allow");
    expect(codexStart("editor", "editor")).toBe("deny");
    expect(codexStart("publisher", "tester")).toBe("deny");
    // Codex's default agent isn't on the team: the rest of the policy decides,
    // and here nothing covers it, so the hook blocks it.
    expect(codexStart("editor")).toBe("none");
  });

  test.each([
    "nodrail apply --yes",
    "nodrail policy lock",
    "nodrail-policy hook x",
  ])("no agent may run %s", (command) => {
    expect(decide("editor", "Bash", { command })).toBe("deny");
  });

  test("on Codex, agents may wait on and message the agents they started", () => {
    expect(decide("editor", "collaborationwait_agent", { timeout_ms: 1 })).toBe(
      "allow",
    );
    expect(decide("publisher", "send_input", { message: "x" })).toBe("allow");
  });

  test.each([
    ["Write", { file_path: "/repo/.claude/agents/publisher.md", content: "x" }],
    [
      "Edit",
      {
        file_path: "/repo/.claude/settings.json",
        old_string: "a",
        new_string: "b",
      },
    ],
    ["Write", { file_path: "/repo/.nodrail/effective.apf.yaml", content: "x" }],
    ["Write", { file_path: "/repo/.agents/skills/s/SKILL.md", content: "x" }],
    ["Write", { file_path: "/repo/nodrail.yaml", content: "x" }],
  ])("no agent may %s %o", (tool, input) => {
    expect(decide("editor", tool, input)).toBe("deny");
  });
});
