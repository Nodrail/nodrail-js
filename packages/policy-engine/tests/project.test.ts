import { describe, expect, test } from "vitest";
import {
  catalogEntry,
  compilePolicies,
  joinPath,
  resolveProject,
  type Catalog,
} from "../src/yaml";
import { memoryHost } from "./support/project-host";

const deny = (operation: string) => `- rule: Deny ${operation}
  tool: github
  operation: ${operation}
  resource: { kind: repository, match: any }
  effect: deny
`;

const openRule = `- rule: Open drafts
  tool: github
  operation: pr.open
  resource: { kind: repository, match: exact, value: { binding: repository } }
  effect: allow
`;

const moduleYaml = (imports: string[], extra = "") => `kind: nodrail.module/v1
parameters:
  repository: { type: repository }
imports: [${imports.join(", ")}]
${extra}`;

const catalog: Catalog = [
  {
    id: "@nodrail/demo",
    version: "1.0.0",
    aliases: ["@nodrail/demo.yaml"],
    files: {
      "module.yaml": moduleYaml(["nested/inner.yaml", "policies/merge.yaml"]),
      "nested/inner.yaml":
        "kind: nodrail.module/v1\nimports: [../policies/open.yaml]\n",
      "policies/open.yaml": openRule,
      "policies/merge.yaml": deny("pr.merge"),
    },
  },
  {
    id: "@nodrail/demo",
    version: "1.1.0",
    files: {
      "module.yaml": moduleYaml(["p.yaml"]),
      "p.yaml": deny("pr.close"),
    },
  },
];

const manifest = (...imports: string[]) =>
  `kind: nodrail.project/v1\nimports:\n${imports.map((entry) => `  - ${entry}`).join("\n")}\n`;

const resolve = (
  files: Record<string, string>,
  extra: Partial<Parameters<typeof resolveProject>[0]> = {},
) => resolveProject({ host: memoryHost(files), catalog, ...extra });

const messages = (result: ReturnType<typeof resolveProject>) =>
  result.problems.map((problem) => `${problem.ref}: ${problem.message}`);

describe("resolving a project", () => {
  test("imports in declared order, nested first, a shared file once", () => {
    const result = resolve({
      "nodrail.yaml": manifest("./a.yaml", "./team/stack.yaml", "./b.yaml"),
      "a.yaml": deny("issues.delete"),
      "team/stack.yaml": manifest("./shared.yaml", "../a.yaml"),
      "team/shared.yaml": deny("repo.delete"),
      "b.yaml": deny("pr.close"),
    });
    expect(result.problems).toEqual([]);
    expect(result.sources.map((source) => source.name)).toEqual([
      "a.yaml",
      "team/shared.yaml",
      "b.yaml",
    ]);
    expect(compilePolicies(result.sources).ok).toBe(true);
  });

  test("a plain rules file is a project too", () => {
    const result = resolve(
      { "rules.yaml": deny("x.y") },
      { manifest: "rules.yaml" },
    );
    expect(result.sources).toEqual([{ name: "rules.yaml", text: deny("x.y") }]);
  });

  test("a catalog module, bound, with its nested modules in order", () => {
    const result = resolve(
      {
        "nodrail.yaml": manifest(
          '{ ref: "@nodrail/demo", with: { repository: acme/widgets } }',
        ),
      },
      { pins: { "@nodrail/demo": "1.0.0" } },
    );
    expect(result.problems).toEqual([]);
    expect(result.sources.map((source) => source.name)).toEqual([
      "@nodrail/demo/policies/open.yaml",
      "@nodrail/demo/policies/merge.yaml",
    ]);
    expect(result.sources[0]?.text).toContain('value: "acme/widgets"');
    expect(result.modules[0]).toMatchObject({
      id: "@nodrail/demo",
      version: "1.0.0",
      bindings: { repository: "acme/widgets" },
      missing: [],
    });
  });

  test("an unversioned import takes the lock's pin, else the newest", () => {
    const files = {
      "nodrail.yaml": manifest(
        '{ ref: "@nodrail/demo", with: { repository: a/b } }',
      ),
    };
    expect(resolve(files).modules[0]?.version).toBe("1.1.0");
    const pinned = resolve(files, { pins: { "@nodrail/demo": "1.0.0" } });
    expect(pinned.modules[0]?.version).toBe("1.0.0");
  });

  test("an alias is the same module", () => {
    const result = resolve({
      "nodrail.yaml": manifest(
        '{ ref: "@nodrail/demo.yaml", with: { repository: a/b } }',
        '{ ref: "@nodrail/demo", with: { repository: a/b } }',
      ),
    });
    expect(result.problems).toEqual([]);
    expect(result.modules).toHaveLength(1);
  });

  test("an unbound module is kept but contributes nothing yet", () => {
    const result = resolve({
      "nodrail.yaml": manifest('"@nodrail/demo"', "./team.yaml"),
      "team.yaml": deny("issues.delete"),
    });
    expect(result.problems).toEqual([]);
    expect(result.modules[0]?.missing).toEqual(["repository"]);
    expect(result.sources.map((source) => source.name)).toEqual(["team.yaml"]);
  });

  test("a waiting module is still checked, with a stand-in value", () => {
    const result = resolve(
      {
        "nodrail.yaml": manifest('"@nodrail/demo"', "./team.yaml"),
        "team.yaml": deny("issues.delete"),
      },
      { pins: { "@nodrail/demo": "1.0.0" } },
    );
    expect(result.checking.map((source) => source.name)).toEqual([
      "@nodrail/demo/policies/open.yaml",
      "@nodrail/demo/policies/merge.yaml",
      "team.yaml",
    ]);
    expect(result.checking[0]?.text).toContain(
      'value: "configuration-required/repository"',
    );
    expect(compilePolicies(result.checking).ok).toBe(true);
  });
});

describe("refusing a project", () => {
  test.each([
    [
      "a cycle",
      {
        "nodrail.yaml": manifest("./a.yaml"),
        "a.yaml": manifest("./nodrail.yaml"),
      },
      "./nodrail.yaml: Import cycle: nodrail.yaml → a.yaml → nodrail.yaml",
    ],
    [
      "a missing file",
      { "nodrail.yaml": manifest("./gone.yaml") },
      "./gone.yaml: No such file",
    ],
    [
      "a path out of the folder",
      { "nodrail.yaml": manifest("../outside.yaml") },
      "../outside.yaml: The path leaves the project folder",
    ],
    [
      "a bare name",
      { "nodrail.yaml": manifest("team.yaml") },
      "team.yaml: Local imports start with ./ and end in .yaml",
    ],
    [
      "an unknown publisher",
      { "nodrail.yaml": manifest('"@someone/thing"') },
      "@someone/thing: Unknown publisher: only @nodrail/ modules are available",
    ],
    [
      "a missing module",
      { "nodrail.yaml": manifest('"@nodrail/none"') },
      "@nodrail/none: No module named @nodrail/none",
    ],
    [
      "a version in the manifest",
      { "nodrail.yaml": manifest('"@nodrail/demo@1.0.0"') },
      "@nodrail/demo@1.0.0: Versions live in nodrail.lock.yaml, not the manifest",
    ],
    [
      "a wildcard repository",
      {
        "nodrail.yaml": manifest(
          '{ ref: "@nodrail/demo", with: { repository: "acme/*" } }',
        ),
      },
      "@nodrail/demo: repository: Expected an exact repository, like acme/widgets",
    ],
    [
      "an unknown value",
      {
        "nodrail.yaml": manifest(
          '{ ref: "@nodrail/demo", with: { branch: main } }',
        ),
      },
      "@nodrail/demo: @nodrail/demo has no parameter branch",
    ],
    [
      "values on a local file",
      {
        "nodrail.yaml": manifest(
          "{ ref: ./a.yaml, with: { repository: a/b } }",
        ),
        "a.yaml": "",
      },
      "./a.yaml: Only catalog modules take values",
    ],
    [
      "neither rules nor a manifest",
      { "nodrail.yaml": manifest("./a.yaml"), "a.yaml": "name: x\n" },
      "./a.yaml: Expected rules or a nodrail.project/v1 manifest",
    ],
  ])("%s", (_name, files: Record<string, string>, expected) => {
    expect(messages(resolve(files))).toContain(expected);
  });

  test("conflicting values for the same module", () => {
    const result = resolve({
      "nodrail.yaml": manifest(
        '{ ref: "@nodrail/demo", with: { repository: a/b } }',
        '{ ref: "@nodrail/demo", with: { repository: a/c } }',
      ),
    });
    expect(messages(result)).toEqual([
      "@nodrail/demo: @nodrail/demo is imported with different values",
    ]);
  });

  test("a link out of the folder", () => {
    const result = resolveProject({
      host: memoryHost(
        { "nodrail.yaml": manifest("./link.yaml") },
        { "link.yaml": undefined },
      ),
      catalog,
    });
    expect(messages(result)).toEqual([
      "./link.yaml: The path leaves the project folder",
    ]);
  });

  test("a version the catalog lacks", () => {
    expect(catalogEntry(catalog, "@nodrail/demo@2.0.0")).toEqual({
      problem:
        "@nodrail/demo@2.0.0 is not in this catalog (it has 1.1.0, 1.0.0)",
    });
  });

  test("a module file that uses an undeclared value", () => {
    const broken: Catalog = [
      {
        id: "@nodrail/broken",
        version: "1.0.0",
        files: {
          "module.yaml": "kind: nodrail.module/v1\nimports: [p.yaml]\n",
          "p.yaml": openRule,
        },
      },
    ];
    const result = resolveProject({
      host: memoryHost({ "nodrail.yaml": manifest('"@nodrail/broken"') }),
      catalog: broken,
    });
    expect(messages(result)).toEqual([
      "p.yaml: Uses undeclared value repository",
    ]);
  });
});

describe("joining paths", () => {
  test.each([
    ["nodrail.yaml", "./a.yaml", "a.yaml"],
    ["team/x.yaml", "../a.yaml", "a.yaml"],
    ["team/x.yaml", "./b/c.yaml", "team/b/c.yaml"],
    ["x.yaml", "../a.yaml", null],
    ["x.yaml", "/etc/a.yaml", null],
    ["x.yaml", "..\\a.yaml", null],
  ])("%s + %s", (from, ref, expected) => {
    expect(joinPath(from, ref)).toBe(expected);
  });
});
