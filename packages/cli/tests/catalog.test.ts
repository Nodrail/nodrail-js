// Every catalog module, installed the way a team would and decided by the
// evaluator. File and shell calls are described exactly as the Claude Code
// hook describes them; GitHub calls use the vocabulary an adapter must speak.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simulate } from "@nodrail/policy-engine";
import { describeToolCall } from "@nodrail/policy-engine/actions";
import {
  compilePolicies,
  renameAgents,
  starterPacks,
} from "@nodrail/policy-engine/yaml";
import { parse } from "yaml";
import { describe, expect, test } from "vitest";
import { bundledCatalog } from "../src/project/catalog.ts";
import {
  stepEvents,
  type Step,
} from "../../policy-engine/tests/support/run-events.ts";
import { fakeIo } from "./support/fake-io.ts";

const REPO = "acme/widgets";
const now = new Date("2026-11-17T12:00:00.000Z");

/** A folder with these modules added, bound to REPO, locked and exported. */
async function installed(refs: string[], extra: Record<string, string> = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "nodrail-catalog-"));
  for (const [path, text] of Object.entries(extra))
    writeFileSync(join(cwd, path), text);
  const run = async (...argv: string[]) => {
    const terminal = fakeIo({ cwd });
    const code = await terminal.run(...argv);
    return { code, out: terminal.stdout(), err: terminal.stderr() };
  };
  for (const ref of refs) expect((await run("add", ref)).err).toBe("");
  const manifest = join(cwd, "nodrail.yaml");
  writeFileSync(
    manifest,
    readFileSync(manifest, "utf8").replaceAll(
      'repository: ""',
      `repository: ${REPO}`,
    ),
  );
  const locked = await run("policy", "lock");
  expect(locked.err).toBe("");
  const exported = await run("policy", "export", "--frozen");
  expect(exported.code).toBe(0);
  const compiled = compilePolicies([{ name: "e.yaml", text: exported.out }]);
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.issues));
  return { cwd, document: compiled.document, review: locked.out };
}

type Decide = (
  agent: string,
  call: { tool: string; input: Record<string, unknown> } | GitHubCall,
  steps?: Step[],
) => string;

type GitHubCall = {
  github: string;
  repo?: string;
  params?: Record<string, unknown>;
};

/** Decides calls against an installed policy, as an agent in `cwd`. */
function decider(document: unknown, cwd: string): Decide {
  return (agent, call, steps = []) => {
    const action =
      "github" in call
        ? {
            tool: "github",
            operation: call.github,
            resource: { kind: "repository", id: call.repo ?? REPO },
            params: call.params ?? {},
          }
        : describeToolCall(call.tool, call.input, cwd);
    if (!action) throw new Error("not a call the hook describes");
    return simulate({
      document,
      descriptor: {
        agentId: agent,
        installationId: "laptop",
        toolKey: action.tool,
        operationKey: action.operation,
        resourceKind: action.resource.kind,
        resourceId: action.resource.id,
        params: action.params,
      },
      run: {
        run: "r",
        step: null,
        events: stepEvents(steps, now.toISOString()),
      },
      now,
    } as Parameters<typeof simulate>[0]).outcome;
  };
}

const bash = (command: string) => ({ tool: "Bash", input: { command } });
const edit = (path: string) => ({
  tool: "Edit",
  input: { file_path: path, old_string: "a", new_string: "b" },
});
const read = (path: string) => ({ tool: "Read", input: { file_path: path } });
const spawn = (subagent_type: string) => ({
  tool: "Agent",
  input: { subagent_type, prompt: "End with a verdict." },
});

const reviewed: Step[] = [
  ["dev"],
  ["qa", "pass"],
  ["gatekeeper", "pass"],
  ["reviewer", "ship"],
];

describe("@nodrail/merge-reviewed-pr", () => {
  test("the merger merges only once QA, checks and review pass on the head", async () => {
    const { document, cwd } = await installed(["@nodrail/merge-reviewed-pr"]);
    const decide = decider(document, cwd);
    const merge = { github: "pr.merge" };
    expect(decide("merger", merge, reviewed)).toBe("allow");
    // A push after QA: QA's pass no longer counts.
    expect(decide("merger", merge, [...reviewed, ["dev"]])).toBe("deny");
    expect(decide("merger", merge, reviewed.slice(0, 3))).toBe("deny");
    expect(
      decide("merger", { ...merge, repo: "acme/other" }, reviewed),
    ).not.toBe("allow");
    expect(decide("dev", merge, reviewed)).not.toBe("allow");
  });

  test("the merger can't push, change files, use the shell or start checkers", async () => {
    const { document, cwd } = await installed([
      "@nodrail/read-only",
      "@nodrail/merge-reviewed-pr",
    ]);
    const decide = decider(document, cwd);
    for (const call of [
      bash("gh pr merge 12 --squash"),
      bash("gh api -X PUT repos/acme/widgets/pulls/12/merge"),
      bash("git push origin main"),
      bash("git status"),
      edit(join(cwd, "src/app.ts")),
      { github: "pr.push" },
      spawn("qa"),
      spawn("reviewer"),
    ])
      expect(decide("merger", call, reviewed)).toBe("deny");
  });

  test("a project's own file can keep merging for people only", async () => {
    const people = `- rule: Merge reviewed pull requests
  effect: deny
  override: { effect: replace }
`;
    const { document, cwd } = await installed(
      ["@nodrail/merge-reviewed-pr", "./people.yaml"],
      { "people.yaml": people },
    );
    const decide = decider(document, cwd);
    expect(decide("merger", { github: "pr.merge" }, reviewed)).toBe("deny");
  });
});

describe("@nodrail/triage-issues", () => {
  test("triage reads, comments and labels in the repository", async () => {
    const { document, cwd } = await installed(["@nodrail/triage-issues"]);
    const decide = decider(document, cwd);
    for (const github of ["issues.read", "issues.comment", "issues.label"]) {
      expect(decide("triage", { github })).toBe("allow");
      expect(decide("triage", { github, repo: "acme/other" })).not.toBe(
        "allow",
      );
      expect(decide("dev", { github })).not.toBe("allow");
    }
  });

  test("triage changes nothing else, anywhere", async () => {
    const { document, cwd } = await installed(["@nodrail/triage-issues"]);
    const decide = decider(document, cwd);
    for (const github of [
      "issues.close",
      "issues.assign",
      "pr.open",
      "pr.merge",
      "repositories.delete",
    ])
      expect(decide("triage", { github })).toBe("deny");
    expect(decide("triage", edit(join(cwd, "README.md")))).toBe("deny");
    expect(decide("triage", bash("git push"))).toBe("deny");
    expect(decide("triage", bash("npm test"))).toBe("deny");
  });

  test("with @nodrail/read-only first, triage reads code but not secrets", async () => {
    const { document, cwd } = await installed([
      "@nodrail/read-only",
      "@nodrail/triage-issues",
    ]);
    const decide = decider(document, cwd);
    expect(decide("triage", read(join(cwd, "src/app.ts")))).toBe("allow");
    expect(decide("triage", read(join(cwd, ".env")))).toBe("deny");
  });
});

describe("@nodrail/dependency-updates", () => {
  test("deps writes lockfiles by name; never package.json", async () => {
    const { document, cwd } = await installed(["@nodrail/dependency-updates"]);
    const decide = decider(document, cwd);
    for (const file of ["pnpm-lock.yaml", "packages/ui/package-lock.json"])
      expect(decide("deps", edit(join(cwd, file)))).toBe("allow");
    expect(decide("deps", edit(join(cwd, "package.json")))).toBe("deny");
    expect(decide("dev", edit(join(cwd, "pnpm-lock.yaml")))).not.toBe("allow");
  });

  test.each([
    ["a folder named like a dependency file", "scripts/package.json/run.sh"],
    ["a made-up lockfile folder", "bun.lock/payload.js"],
    ["an installed package", "node_modules/typescript/package.json"],
    ["an installed package's lockfile", "node_modules/x/yarn.lock"],
    ["pnpm's workspace config", "pnpm-workspace.yaml"],
    ["git's own files", ".git/hooks/pre-commit"],
    ["source code", "src/index.ts"],
  ])("deps can't change %s", async (_name, file) => {
    const { document, cwd } = await installed(["@nodrail/dependency-updates"]);
    expect(decider(document, cwd)("deps", edit(join(cwd, file)))).not.toBe(
      "allow",
    );
  });

  test("lockfiles refresh only with scripts and pnpm's config hook off", async () => {
    const { document, cwd } = await installed(["@nodrail/dependency-updates"]);
    const decide = decider(document, cwd);
    expect(
      decide(
        "deps",
        bash("pnpm install --lockfile-only --ignore-scripts --ignore-pnpmfile"),
      ),
    ).toBe("allow");
    expect(
      decide("deps", bash("npm install --package-lock-only --ignore-scripts")),
    ).toBe("allow");
    for (const command of [
      "pnpm install --lockfile-only",
      "pnpm install",
      "yarn install --mode update-lockfile",
      "npm install --package-lock-only",
    ])
      expect(decide("deps", bash(command))).not.toBe("allow");
  });

  test("commits and pushes its branch; never main, force, mirror or delete", async () => {
    const { document, cwd } = await installed(["@nodrail/dependency-updates"]);
    const decide = decider(document, cwd);
    expect(decide("deps", bash('git commit -m "bump"'))).toBe("allow");
    expect(decide("deps", bash("git push origin deps"))).toBe("allow");
    for (const command of [
      "git push",
      "git push origin",
      "git push origin main",
      "git push origin master --force",
      "git push origin HEAD:main",
      "git push --force",
      "git push -f origin deps",
      "git push --force-with-lease",
      "git push --mirror",
      "git push --delete origin main",
    ])
      expect(decide("deps", bash(command))).toBe("deny");
  });

  test("a draft opens from a candidate after the checks pass; never a merge", async () => {
    const { document, cwd } = await installed(["@nodrail/dependency-updates"]);
    const decide = decider(document, cwd);
    const draft = {
      github: "pr.open",
      params: { draft: true, targetScope: "candidate" },
    };
    const checked: Step[] = [["deps"], ["gatekeeper", "pass"]];
    expect(decide("deps", draft, checked)).toBe("allow");
    expect(decide("deps", draft, [["gatekeeper", "pass"], ["deps"]])).toBe(
      "deny",
    );
    expect(
      decide("deps", { ...draft, params: { draft: true } }, checked),
    ).not.toBe("allow");
    expect(decide("deps", { github: "pr.merge" })).toBe("deny");
    expect(decide("deps", spawn("gatekeeper"))).toBe("deny");
  });
});

describe("@nodrail/read-only", () => {
  test("its newest version is the read-only starter pack, byte for byte", () => {
    const module = bundledCatalog()
      .filter((entry) => entry.id === "@nodrail/read-only")
      .sort((a, b) =>
        b.version.localeCompare(a.version, undefined, { numeric: true }),
      )[0];
    expect(module?.files["policies/read-only.yaml"]).toBe(
      starterPacks["read-only"].text,
    );
  });

  test("needs no values and blocks Nodrail's own commands", async () => {
    const { document, cwd } = await installed(["@nodrail/read-only"]);
    const decide = decider(document, cwd);
    expect(decide("dev", bash("git status"))).toBe("allow");
    expect(decide("dev", bash("nodrail approve 6d1c2f0a"))).toBe("deny");
    expect(decide("dev", edit(join(cwd, "a.ts")))).toBe("none");
  });
});

describe("the whole catalog", () => {
  const ids = [...new Set(bundledCatalog().map((module) => module.id))].sort();

  test("has these modules", () => {
    expect(ids).toEqual([
      "@nodrail/dependency-updates",
      "@nodrail/merge-reviewed-pr",
      "@nodrail/open-reviewed-pr",
      "@nodrail/read-only",
      "@nodrail/triage-issues",
    ]);
  });

  // A binding must map every agent a module's rules name, so a module must
  // say what each one does. Published versions never change; the newest
  // version of each is the one held to this.
  test("each module's newest version declares every agent its rules name", () => {
    for (const id of ids) {
      const [newest] = bundledCatalog()
        .filter((module) => module.id === id)
        .sort((a, b) =>
          b.version.localeCompare(a.version, undefined, { numeric: true }),
        );
      const declared = Object.keys(
        (parse(newest!.files["module.yaml"]!) as { roles?: object }).roles ??
          {},
      );
      const named = new Set(
        Object.entries(newest!.files)
          .filter(([path]) => path.endsWith(".yaml"))
          .map(([, text]) => text)
          .filter((text) => Array.isArray(parse(text)))
          .flatMap((text) => renameAgents(text, {}).names),
      );
      expect(
        [...named].filter((name) => !declared.includes(name)),
        id,
      ).toEqual([]);
    }
  });

  test("every module installs together with every other one", async () => {
    const { review } = await installed(ids);
    expect(review).toContain("Permissions, compared with nothing yet");
  });

  test("the publisher still can't merge when a merger is added", async () => {
    const { document, cwd } = await installed([
      "@nodrail/open-reviewed-pr",
      "@nodrail/merge-reviewed-pr",
    ]);
    const decide = decider(document, cwd);
    expect(decide("github", { github: "pr.merge" }, reviewed)).toBe("deny");
    expect(decide("merger", { github: "pr.merge" }, reviewed)).toBe("allow");
  });
});
