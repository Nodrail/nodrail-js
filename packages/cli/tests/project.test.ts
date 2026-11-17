import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compilePolicies } from "@nodrail/policy-engine/yaml";
import { simulate } from "@nodrail/policy-engine";
import { describe, expect, test } from "vitest";
import { stagingFolder } from "../src/project/store.ts";
import { stepEvents } from "../../policy-engine/tests/support/run-events.ts";
import { fakeIo } from "./support/fake-io.ts";

const TEAM = `# Our own rules.
- rule: Never delete issues
  tool: github
  operation: issues.delete
  resource: { kind: issue, match: any }
  effect: deny
`;

/** A project folder, offline: any network use fails the test. */
function project(files: Record<string, string> = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "nodrail-project-"));
  // The person's home, where nodrail stages writes, the same for every run.
  const home = mkdtempSync(join(tmpdir(), "nodrail-home-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(cwd, path, ".."), { recursive: true });
    writeFileSync(join(cwd, path), text);
  }
  const fetch = (() => {
    throw new Error("network used");
  }) as unknown as typeof globalThis.fetch;
  const read = (path: string) => readFileSync(join(cwd, path), "utf8");
  const write = (path: string, text: string) =>
    writeFileSync(join(cwd, path), text);
  const run = async (...argv: string[]) => {
    const terminal = fakeIo({ cwd, home, fetch });
    const code = await terminal.run(...argv);
    return { code, out: terminal.stdout(), err: terminal.stderr() };
  };
  const bind = (repository: string) =>
    write(
      "nodrail.yaml",
      read("nodrail.yaml").replace(
        'repository: ""',
        `repository: ${repository}`,
      ),
    );
  return { cwd, home, read, write, run, bind };
}

/** A project with the official module bound to `repository` and locked. */
async function locked(repository = "acme/widgets") {
  const p = project({ "policies/team.yaml": TEAM });
  expect((await p.run("add", "@nodrail/open-reviewed-pr")).code).toBe(0);
  expect((await p.run("add", "./policies/team.yaml")).code).toBe(0);
  p.bind(repository);
  expect((await p.run("policy", "lock")).code).toBe(0);
  return p;
}

const snapshot = (p: ReturnType<typeof project>) => [
  p.read("nodrail.yaml"),
  p.read("nodrail.lock.yaml"),
];

describe("nodrail add", () => {
  test("a fresh folder, offline: the alias and the id are one dependency", async () => {
    const p = project();
    const first = await p.run("add", "@nodrail/pr_policy.yaml");
    expect(first.code).toBe(0);
    expect(first.out).toContain("Added @nodrail/open-reviewed-pr@1.0.0");
    expect(first.out).toContain("configuration required");
    expect(p.read("nodrail.yaml")).toContain(
      '- ref: "@nodrail/open-reviewed-pr"',
    );
    const before = snapshot(p);
    const again = await p.run("add", "@nodrail/open-reviewed-pr");
    expect(again.out).toContain("already in nodrail.yaml");
    expect(snapshot(p)).toEqual(before);
  });

  test("keeps the manifest's comments, entries and order", async () => {
    const manifest = `# Ours.
kind: nodrail.project/v1
imports:
  # The team's rules come first.
  - ref: ./policies/team.yaml
`;
    const p = project({ "nodrail.yaml": manifest, "policies/team.yaml": TEAM });
    expect((await p.run("add", "@nodrail/open-reviewed-pr")).code).toBe(0);
    expect(p.read("nodrail.yaml"))
      .toBe(`${manifest}  - ref: "@nodrail/open-reviewed-pr"
    with:
      repository: ""
`);
    const before = snapshot(p);
    await p.run("add", "./policies/team.yaml");
    await p.run("add", "@nodrail/pr_policy.yaml");
    expect(snapshot(p)).toEqual(before);
  });

  test("a version the catalog lacks is named, and nothing changes", async () => {
    const p = await locked();
    const before = snapshot(p);
    const result = await p.run("add", "@nodrail/open-reviewed-pr@9.9.9");
    expect(result.code).toBe(1);
    expect(result.err).toContain(
      "@nodrail/open-reviewed-pr@9.9.9 is not in this catalog (it has 1.0.0)",
    );
    expect(snapshot(p)).toEqual(before);
    expect(
      (await p.run("add", "@nodrail/open-reviewed-pr@1.0.0")).out,
    ).toContain("Nothing changed.");
  });

  test.each([
    ["@someone/thing", "Unknown publisher"],
    ["@nodrail/nothing", "No module named @nodrail/nothing"],
    ["./missing.yaml", "./missing.yaml (in nodrail.yaml): No such file"],
    ["../outside.yaml", "The path leaves the project folder"],
    ["team.yaml", "Add a catalog module"],
  ])("refuses %s and keeps a working installation", async (ref, message) => {
    const p = await locked();
    const before = snapshot(p);
    const result = await p.run("add", ref);
    expect(result.code).not.toBe(0);
    expect(result.err).toContain(message);
    expect(snapshot(p)).toEqual(before);
    expect((await p.run("policy", "export", "--frozen")).code).toBe(0);
  });

  test.each([
    [
      "an import cycle",
      {
        "a.yaml": "kind: nodrail.project/v1\nimports: [./b.yaml]\n",
        "b.yaml": "kind: nodrail.project/v1\nimports: [./a.yaml]\n",
      },
      "./a.yaml",
      "Import cycle",
    ],
    [
      "a conflicting rule",
      { "a.yaml": TEAM.replace("deny", "allow") },
      "./a.yaml",
      "doesn't compile",
    ],
  ])("refuses %s", async (_name, files, ref, message) => {
    const p = await locked();
    for (const [path, text] of Object.entries(files)) p.write(path, text);
    const before = snapshot(p);
    const result = await p.run("add", ref);
    expect(result.code).toBe(1);
    expect(result.err).toContain(message);
    expect(snapshot(p)).toEqual(before);
  });

  test("a link out of the project is refused", async () => {
    const p = await locked();
    const outside = mkdtempSync(join(tmpdir(), "nodrail-outside-"));
    writeFileSync(join(outside, "x.yaml"), TEAM);
    symlinkSync(join(outside, "x.yaml"), join(p.cwd, "link.yaml"));
    const result = await p.run("add", "./link.yaml");
    expect(result.err).toContain(
      "./link.yaml (in nodrail.yaml): The path leaves the project folder",
    );
  });

  test("a shared file imported twice compiles once", async () => {
    const p = project({
      "policies/team.yaml": TEAM,
      "stack.yaml":
        "kind: nodrail.project/v1\nimports: [./policies/team.yaml]\n",
    });
    await p.run("add", "./policies/team.yaml");
    expect((await p.run("add", "./stack.yaml")).code).toBe(0);
    expect(p.read("nodrail.lock.yaml")).toContain(
      "order:\n  - policies/team.yaml\n",
    );
  });
});

describe("nodrail policy lock and export --frozen", () => {
  test("two clean folders give the same lock and export, byte for byte", async () => {
    const [a, b] = [await locked(), await locked()];
    expect(a.read("nodrail.lock.yaml")).toBe(b.read("nodrail.lock.yaml"));
    const [ea, eb] = [
      await a.run("policy", "export", "--frozen"),
      await b.run("policy", "export", "--frozen"),
    ];
    expect(ea.out).toBe(eb.out);
    expect(ea.err).toBe("");
    expect(a.read("nodrail.lock.yaml")).not.toContain(a.cwd);
  });

  test("the export is one APF file that compiles", async () => {
    const p = await locked();
    const { out } = await p.run("policy", "export", "--frozen");
    expect(
      compilePolicies([{ name: "effective.apf.yaml", text: out }]).ok,
    ).toBe(true);
    expect(out).toContain('value: "acme/widgets"');
  });

  test("an unbound module stops the export until it has its values", async () => {
    const p = project();
    await p.run("add", "@nodrail/open-reviewed-pr");
    const result = await p.run("policy", "export", "--frozen");
    expect(result).toMatchObject({ code: 1, out: "" });
    expect(result.err).toContain("Configuration required");
  });

  test.each([
    ["a wildcard", "acme/*"],
    ["a path", "../etc"],
  ])("refuses %s as a repository", async (_name, value) => {
    const p = project();
    await p.run("add", "@nodrail/open-reviewed-pr");
    p.bind(JSON.stringify(value));
    const result = await p.run("policy", "lock");
    expect(result.code).toBe(1);
    expect(result.err).toContain("Expected an exact repository");
  });

  test("a changed local file stops the export until it is locked again", async () => {
    const p = await locked();
    p.write(
      "policies/team.yaml",
      TEAM.replace("issues.delete", "issues.close"),
    );
    const stale = await p.run("policy", "export", "--frozen");
    expect(stale).toMatchObject({ code: 1, out: "" });
    expect(stale.err).toContain(
      "policies/team.yaml changed since it was locked",
    );
    const review = await p.run("policy", "lock");
    expect(review.out).toContain("github.issues.close");
    expect((await p.run("policy", "export", "--frozen")).code).toBe(0);
  });

  test("a changed manifest stops the export", async () => {
    const p = await locked();
    p.write(
      "nodrail.yaml",
      p.read("nodrail.yaml").replace("acme/widgets", "acme/other"),
    );
    const result = await p.run("policy", "export", "--frozen");
    expect(result.err).toContain("nodrail.yaml changed since it was locked");
  });

  test("a package that changed at the same version fails integrity", async () => {
    const p = await locked();
    p.write(
      "nodrail.lock.yaml",
      p
        .read("nodrail.lock.yaml")
        .replace(
          /(path: policies\/open.yaml\n\s+sha256: ")\w+/,
          (_all, start: string) => start + "0".repeat(64),
        ),
    );
    for (const argv of [
      ["policy", "export", "--frozen"],
      ["policy", "lock"],
    ]) {
      const result = await p.run(...argv);
      expect(result.code).toBe(1);
      expect(result.err).toContain(
        "@nodrail/open-reviewed-pr@1.0.0 doesn't match nodrail.lock.yaml (policies/open.yaml)",
      );
    }
  });

  test("a lock from a newer engine is refused", async () => {
    const p = await locked();
    p.write(
      "nodrail.lock.yaml",
      p.read("nodrail.lock.yaml").replace(/^engine: \d+$/m, "engine: 99"),
    );
    const result = await p.run("policy", "export", "--frozen");
    expect(result.err).toContain("needs engine level 99");
  });

  test("export without --frozen, or without a lock, says what to do", async () => {
    expect((await project().run("policy", "export")).code).toBe(2);
    const p = project({
      "nodrail.yaml": "kind: nodrail.project/v1\nimports: [./a.yaml]\n",
      "a.yaml": TEAM,
    });
    expect((await p.run("policy", "export", "--frozen")).err).toContain(
      "No nodrail.lock.yaml here",
    );
  });

  test("files that can't simply be joined are exported by meaning", async () => {
    // "[]" then "- rule:" is not YAML once joined; each file alone compiles.
    const p = project({ "empty.yaml": "[]\n", "policies/team.yaml": TEAM });
    await p.run("add", "./empty.yaml");
    await p.run("add", "./policies/team.yaml");
    const { code, out } = await p.run("policy", "export", "--frozen");
    expect(code).toBe(0);
    const exported = compilePolicies([{ name: "e.yaml", text: out }]);
    const separate = compilePolicies([
      { name: "empty.yaml", text: "[]\n" },
      { name: "policies/team.yaml", text: TEAM },
    ]);
    if (!exported.ok || !separate.ok)
      throw new Error("expected both to compile");
    expect(exported.document).toEqual(separate.document);
  });

  test("a removed gate and a widened scope are flagged", async () => {
    const p = project({
      "rules.yaml": `- required_engine_version: 3
- rule: Push
  tool: github
  operation: pr.push
  resource: { kind: branch, match: exact, value: main }
  effect: allow
- gate: Review first
  tool: github
  operation: pr.push
  resource: { kind: branch, match: any }
  requires: [{ agent: reviewer, verdict: ship }]
  otherwise: deny
- rule: Limits
  tool: github
  operation: pr.label
  resource: { kind: label, match: any }
  condition: [{ field: count, op: lt, value: 5 }]
  effect: allow
`,
    });
    await p.run("add", "./rules.yaml");
    p.write(
      "rules.yaml",
      p
        .read("rules.yaml")
        .replace(/- gate:[\s\S]*?otherwise: deny\n/, "")
        .replace("match: exact, value: main", "match: prefix, value: ma")
        .replace("value: 5", "value: 50"),
    );
    const { out } = await p.run("policy", "lock");
    expect(out).toMatch(/!\s+loosened\s+gate review-first/);
    expect(out).toMatch(/loosened\s+rule push/);
    expect(out).toMatch(
      /needs review\s+rule limits|needs_review\s+rule limits/,
    );
  });
});

const CLOSE = TEAM.replace("Never delete issues", "Never close issues").replace(
  "issues.delete",
  "issues.close",
);

describe("reviewing against what was committed", () => {
  const git = (cwd: string, ...args: string[]) =>
    spawnSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
      { cwd, encoding: "utf8" },
    );

  test("an agent that weakens a rule and locks it itself can't hide it", async () => {
    const p = await locked();
    git(p.cwd, "init", "-q");
    git(p.cwd, "add", ".");
    git(p.cwd, "commit", "-qm", "reviewed");
    // The agent removes the team's deny and locks the result itself.
    p.write("policies/team.yaml", "[]\n");
    await p.run("policy", "lock");
    const review = await p.run("policy", "lock");
    expect(review.out).toContain("up to date");
    expect(review.out).toContain(
      "compared with the last committed nodrail.lock.yaml",
    );
    expect(review.out).toMatch(/!\s+loosened\s+rule never-delete-issues/);
  });

  test("outside git, a lock whose review doesn't match it is not trusted", async () => {
    const p = await locked();
    p.write(
      "nodrail.lock.yaml",
      p
        .read("nodrail.lock.yaml")
        .replace(/^baseline: [\s\S]*$/m, 'baseline: "[]\\n"\n'),
    );
    p.write(
      "policies/team.yaml",
      TEAM.replace("issues.delete", "issues.close"),
    );
    const { out } = await p.run("policy", "lock");
    expect(out).toContain("doesn't hold its own review");
  });
});

describe("a write killed partway", () => {
  const tsx = fileURLToPath(
    new URL("../node_modules/.bin/tsx", import.meta.url),
  );
  const helper = fileURLToPath(
    new URL("./support/crashing-nodrail.ts", import.meta.url),
  );
  /** Runs a real `nodrail` that dies at `step`, leaving whatever it left. */
  const killed = (
    { cwd, home }: { cwd: string; home: string },
    step: string,
    ...argv: string[]
  ) =>
    spawnSync(tsx, [helper, ...argv], {
      cwd,
      env: { ...process.env, HOME: home, CRASH_ON: step },
      encoding: "utf8",
    }).status;

  test.each(["rename:1", "rename:2"])(
    "after every new file was written (killed at %s), the new state wins",
    async (step) => {
      const p = await locked();
      p.write("close.yaml", CLOSE);
      expect(killed(p, step, "add", "./close.yaml")).toBe(9);
      // Possibly half moved: a frozen export won't read it.
      const refused = await p.run("policy", "export", "--frozen");
      expect(refused).toMatchObject({ code: 1, out: "" });
      expect(refused.err).toContain("interrupted");
      // The next writer finishes the move, so the add is already whole.
      expect((await p.run("add", "./close.yaml")).out).toContain(
        "Nothing changed.",
      );
      expect((await p.run("policy", "export", "--frozen")).out).toContain(
        "issues.close",
      );
    },
  );

  test("before every new file was written, the old state stays", async () => {
    const p = await locked();
    const before = snapshot(p);
    p.write("close.yaml", CLOSE);
    expect(killed(p, "ready", "add", "./close.yaml")).toBe(9);
    expect((await p.run("policy", "lock")).out).toContain("up to date");
    expect(snapshot(p)).toEqual(before);
  });

  test("a write planted in the repository is never put in place", async () => {
    const p = await locked();
    p.write(
      "effective.apf.yaml",
      "- rule: Reviewed\n  command: ls\n  effect: allow\n",
    );
    const planted =
      "- rule: Anything\n  command: { prefix: '' }\n  effect: allow\n";
    mkdirSync(join(p.cwd, ".nodrail-write", "next"), { recursive: true });
    p.write(".nodrail-write/next/effective.apf.yaml", planted);
    p.write(".nodrail-write/ready", "");
    await p.run("policy", "lock");
    expect(p.read("effective.apf.yaml")).not.toBe(planted);
  });

  test("a staged write that changed after staging is dropped, not applied", async () => {
    const p = await locked();
    const before = snapshot(p);
    const folder = stagingFolder({ root: p.cwd, home: p.home });
    mkdirSync(join(folder, "next"), { recursive: true });
    writeFileSync(join(folder, "next", "nodrail.yaml"), "kind: changed\n");
    writeFileSync(join(folder, "next", "effective.apf.yaml"), "anything\n");
    writeFileSync(
      join(folder, "ready"),
      JSON.stringify({
        "nodrail.yaml": "0".repeat(64),
        "effective.apf.yaml": "0".repeat(64),
      }),
    );
    expect((await p.run("policy", "lock")).code).toBe(0);
    expect(snapshot(p)).toEqual(before);
  });

  test("a writer that is still running holds the project", async () => {
    const p = await locked();
    const folder = stagingFolder({ root: p.cwd, home: p.home });
    mkdirSync(folder, { recursive: true });
    // This test's own parent process stands in for another running nodrail.
    writeFileSync(join(folder, "owner"), String(process.ppid));
    const result = await p.run("policy", "lock");
    expect(result.err).toContain("is changing this project");
  });
});

describe("the reviewed-PR module, bound to two repositories", () => {
  /** The pilot's three steps, decided by the exported policy. */
  async function decide(
    repository: string,
    call: { repo: string; op: string; qaAt: string; head: string },
  ) {
    const p = await locked(repository);
    const { out } = await p.run("policy", "export", "--frozen");
    const compiled = compilePolicies([{ name: "e.yaml", text: out }]);
    if (!compiled.ok) throw new Error("export doesn't compile");
    const at = "2026-01-01T00:00:00Z";
    const verdicts = [
      ["qa", "pass", call.qaAt],
      ["gatekeeper", "pass", call.head],
      ["reviewer", "ship", call.head],
    ];
    // The adapter passes only evidence for the current head.
    const events = stepEvents(
      verdicts
        .filter(([, , head]) => head === call.head)
        .map(([agent, verdict]) => [agent!, verdict] as const),
      at,
    );
    return simulate({
      document: compiled.document,
      descriptor: {
        agentId: "github",
        installationId: "local",
        toolKey: "github",
        operationKey: call.op,
        resourceKind: "repository",
        resourceId: call.repo,
        params: { draft: true, targetScope: "candidate" },
      },
      run: { run: "r", step: null, events },
      now: new Date(at),
    } as Parameters<typeof simulate>[0]).outcome;
  }

  test.each(["acme/widgets", "octo/tools"])(
    "%s: stale QA denied, fresh QA opens, merge denied",
    async (repo) => {
      expect(
        await decide(repo, { repo, op: "pr.open", qaAt: "A", head: "B" }),
      ).toBe("deny");
      expect(
        await decide(repo, { repo, op: "pr.open", qaAt: "B", head: "B" }),
      ).toBe("allow");
      expect(
        await decide(repo, { repo, op: "pr.merge", qaAt: "B", head: "B" }),
      ).toBe("deny");
    },
  );

  test("another repository cannot be opened", async () => {
    expect(
      await decide("acme/widgets", {
        repo: "acme/other",
        op: "pr.open",
        qaAt: "B",
        head: "B",
      }),
    ).not.toBe("allow");
  });
});
