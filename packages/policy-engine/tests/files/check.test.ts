// A whole write checked against file contracts before it runs (DC-04.2):
// every touched file planned and judged first, multi-file patches pass only
// as a whole, deletes and moves out need their own permission, and the
// answer is preflight-only unless a mediated writer applies it.
import { describe, expect, test } from "vitest";
import {
  checkWrite,
  contractsFor,
  governs,
  planWrite,
  projectPath,
  type CurrentFile,
  type WriteCheckInput,
  type WriteRequest,
} from "../../src/files/index";
import { CONTRACTS, contract, fixture } from "./support";

const ROOT = "/work/project";
const ADR = fixture("adr", "valid.md");
const NOTE = fixture("memory", "valid.md");

function check(
  request: WriteRequest,
  files: Record<string, CurrentFile | string> = {},
  more: Partial<WriteCheckInput> = {},
) {
  return checkWrite({
    request,
    projectRoot: ROOT,
    cwd: ROOT,
    contracts: CONTRACTS,
    agent: "scribe",
    current: (path) => {
      const found = files[path];
      if (found === undefined) return { state: "absent" };
      return typeof found === "string"
        ? { state: "present", content: found }
        : found;
    },
    ...more,
  });
}

const write = (path: string, content: string): WriteRequest => ({
  tool: "write",
  path: `${ROOT}/${path}`,
  content,
});
const edit = (
  path: string,
  oldString: string,
  newString: string,
  replaceAll = false,
): WriteRequest => ({
  tool: "edit",
  path: `${ROOT}/${path}`,
  oldString,
  newString,
  replaceAll,
});
const patch = (...lines: string[]): WriteRequest => ({
  tool: "patch",
  patch: ["*** Begin Patch", ...lines, "*** End Patch"].join("\n"),
});
const added = (text: string) =>
  text
    .trimEnd()
    .split("\n")
    .map((line) => `+${line}`);

describe("paths", () => {
  test.each([
    ["a.md", { ok: true, path: "a.md" }],
    [`${ROOT}/docs/adr/x.md`, { ok: true, path: "docs/adr/x.md" }],
    [`${ROOT}//docs/./adr/x.md`, { ok: true, path: "docs/adr/x.md" }],
    ["/elsewhere/x.md", { ok: false, code: "outside" }],
    [ROOT, { ok: false, code: "outside" }],
    ["", { ok: false, code: "unsafe-path" }],
    ["docs/../x.md", { ok: false, code: "unsafe-path" }],
    ["docs\\adr\\x.md", { ok: false, code: "unsafe-path" }],
    ["docs/a\u0000.md", { ok: false, code: "unsafe-path" }],
    [`${"a/".repeat(40)}x.md`, { ok: false, code: "unsafe-path" }],
  ])("%s", (name, expected) => {
    expect(projectPath(ROOT, ROOT, name)).toMatchObject(expected);
  });

  test("any spelling of the project folder is inside it", () => {
    expect(
      projectPath(
        ["/tmp/p", "/private/tmp/p"],
        "/tmp/p",
        "/private/tmp/p/a.md",
      ),
    ).toEqual({ ok: true, path: "a.md" });
  });

  test("case and Unicode form never take a file out of a contract", () => {
    const adr = contract("adr");
    expect(governs(adr, "docs/adr/0001.md")).toBe(true);
    // Declared as NFC; written decomposed, it is the same file on APFS.
    expect(
      governs({ ...adr, pattern: "caf\u00e9.md" }, "docs/adr/cafe\u0301.md"),
    ).toBe(true);
    expect(governs(adr, "Docs/ADR/0001.MD")).toBe(true);
    expect(governs(adr, "docs/adr/cafe\u0301.md")).toBe(true);
    expect(governs(adr, "docs/adr/sub/0001.md")).toBe(false);
    expect(governs(adr, "docs/adrx/0001.md")).toBe(false);
    expect(
      governs(contract("handoff"), "notes/handovers/wave-4/HANDOVER.md"),
    ).toBe(true);
    expect(governs(contract("handoff"), "notes/handovers/HANDOVER.md")).toBe(
      false,
    );
    // memory/*.md is one level: lessons below it have their own contract.
    expect(
      contractsFor(CONTRACTS, "memory/lessons/a.md").map((c) => c.name),
    ).toEqual(["lesson"]);
  });
});

describe("whole-content writes", () => {
  test("a valid note is allowed, preflight-only, never atomic", () => {
    const result = check(write("memory/root-cause.md", NOTE));
    expect(result).toMatchObject({
      decision: "allow",
      guarantee: "preflight-only",
      atomic: false,
      reason: null,
      files: [
        {
          path: "memory/root-cause.md",
          operation: "create",
          contracts: ["memory"],
          outcome: "pass",
        },
      ],
      expected: [
        { path: "memory/root-cause.md", state: "absent", revision: null },
      ],
    });
    expect(result.files[0]!.readings[0]).toMatchObject({
      state: "valid",
      frontmatter: { type: "feedback" },
    });
  });

  test("a mediated writer gets the revisions to re-check", () => {
    const result = check(
      write("memory/a.md", NOTE),
      { "memory/a.md": "old" },
      { mediated: true },
    );
    expect(result.guarantee).toBe("mediated");
    expect(result.atomic).toBe(false);
    expect(result.expected).toEqual([
      {
        path: "memory/a.md",
        state: "present",
        revision: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      },
    ]);
    const given = check(write("memory/a.md", NOTE), {
      "memory/a.md": {
        state: "present",
        content: new Uint8Array(),
        revision: "sha256:x",
      },
    });
    expect(given.expected[0]!.revision).toBe("sha256:x");
    const bytes = check(write("memory/a.md", NOTE), {
      "memory/a.md": { state: "present", content: new Uint8Array() },
    });
    expect(bytes.expected[0]!.revision).toBeNull();
  });

  test("an invalid note is denied with a safe reason", () => {
    const result = check(
      write("memory/a.md", fixture("memory", "invalid-kind.md")),
    );
    expect(result).toMatchObject({
      decision: "deny",
      reason:
        "memory:frontmatter.type: expected one of user, feedback, project, reference",
    });
  });

  test("oversize and invalid UTF-8 content are denied", () => {
    const big = check(
      write("evals/runs/a.md", fixture("eval", "valid.md") + "x".repeat(5000)),
    );
    expect(big.files[0]!.issues[0]).toMatchObject({ code: "size" });
    const bad = check(write("memory/a.md", `${NOTE}\uDC00`));
    expect(bad.files[0]!.issues[0]).toMatchObject({ code: "encoding" });
  });

  test("only declared writers; the main session is no writer", () => {
    expect(
      check(write("docs/adr/1.md", ADR), {}, { agent: "architect" }).decision,
    ).toBe("allow");
    expect(
      check(write("docs/adr/1.md", ADR), {}, { agent: "intern" }),
    ).toMatchObject({
      decision: "deny",
      files: [{ issues: [{ path: "adr", code: "writer" }] }],
    });
    expect(
      check(write("docs/adr/1.md", ADR), {}, { agent: null }).decision,
    ).toBe("deny");
    // No writers list: any agent.
    expect(
      check(
        write("memory/lessons/a.md", fixture("lesson", "valid.md")),
        {},
        { agent: null },
      ).decision,
    ).toBe("allow");
  });

  test("ungoverned files aren't this check's business", () => {
    expect(check(write("src/a.ts", "x"))).toMatchObject({
      decision: "not-governed",
      files: [{ outcome: "not-governed", contracts: [] }],
    });
    expect(check(write("../outside.md", "x")).decision).toBe("deny");
    expect(
      check({ tool: "write", path: "/elsewhere/a.md", content: "x" }),
    ).toMatchObject({
      decision: "not-governed",
      files: [{ path: null }],
    });
  });

  test("protected paths stay protected, contract or not", () => {
    const isProtected = (path: string) => path.startsWith("memory/");
    expect(
      check(write("memory/a.md", NOTE), {}, { isProtected }),
    ).toMatchObject({
      decision: "deny",
      files: [{ issues: [{ code: "protected" }] }],
    });
  });

  test("a path the adapter found unsafe is refused, governed or not", () => {
    const unsafe: CurrentFile = {
      state: "unsafe",
      reason: "is reached through a symlink",
    };
    expect(
      check(write("notes/link.md", "x"), { "notes/link.md": unsafe }),
    ).toMatchObject({
      decision: "deny",
      reason: "notes/link.md: is reached through a symlink",
    });
  });
});

describe("Edit", () => {
  const current = { "docs/adr/1.md": ADR };

  test("the reconstructed file is what's validated", () => {
    expect(
      check(
        edit("docs/adr/1.md", "status: accepted", "status: superseded"),
        current,
      ).decision,
    ).toBe("allow");
    const broken = check(
      edit("docs/adr/1.md", "## Consequences", "## Outcome"),
      current,
    );
    expect(broken).toMatchObject({
      decision: "deny",
      files: [
        {
          operation: "update",
          issues: [{ path: "adr:sections.Consequences", code: "required" }],
        },
      ],
    });
  });

  test("an ambiguous old_string can't be reconstructed, so it is denied", () => {
    const result = check(
      edit("docs/adr/1.md", "## Decision", "## Choice"),
      current,
    );
    expect(result.files[0]!.issues).toContainEqual(
      expect.objectContaining({
        code: "unreconstructable",
        message: expect.stringContaining("occurs 2 times"),
      }),
    );
  });

  test("a current file that isn't text can't be edited under a contract", () => {
    const bytes = Uint8Array.from([0xff, 0xfe]);
    const result = check(edit("docs/adr/1.md", "a", "b"), {
      "docs/adr/1.md": { state: "present", content: bytes },
    });
    expect(result.files[0]!.issues[0]).toMatchObject({
      code: "unreconstructable",
      message: "the current file isn't valid UTF-8",
    });
    const unsafe = check(edit("docs/adr/1.md", "a", "b"), {
      "docs/adr/1.md": { state: "unsafe", reason: "isn't a regular file" },
    });
    expect(unsafe.files[0]!.issues.map((i) => i.code)).toEqual([
      "unsafe-path",
      "unreconstructable",
    ]);
  });

  test("an edit creating a file", () => {
    expect(check(edit("memory/new.md", "", NOTE))).toMatchObject({
      decision: "allow",
      files: [{ operation: "create" }],
    });
  });
});

describe("apply_patch", () => {
  test("a multi-file patch passes only when every governed file does", () => {
    const good = patch(
      "*** Add File: memory/a.md",
      ...added(NOTE),
      "*** Add File: src/x.ts",
      "+x",
    );
    expect(check(good)).toMatchObject({
      decision: "allow",
      files: [{ outcome: "pass" }, { outcome: "not-governed" }],
    });
    const bad = patch(
      "*** Add File: memory/a.md",
      ...added(NOTE),
      "*** Add File: memory/b.md",
      ...added(fixture("memory", "invalid-missing-field.md")),
    );
    expect(check(bad)).toMatchObject({
      decision: "deny",
      files: [{ outcome: "pass" }, { outcome: "fail" }],
    });
  });

  test("an update is applied to the current file, then validated", () => {
    const update = patch(
      "*** Update File: docs/adr/1.md",
      "@@ ## Consequences",
      " ",
      "-Writes whose result can't be reconstructed are refused for governed files.",
      "+Refused.",
    );
    expect(check(update, { "docs/adr/1.md": ADR })).toMatchObject({
      decision: "allow",
      files: [{ operation: "update" }],
    });
    const drop = patch(
      "*** Update File: docs/adr/1.md",
      "-## Consequences",
      "+## Outcome",
    );
    expect(check(drop, { "docs/adr/1.md": ADR }).decision).toBe("deny");
    const stale = patch(
      "*** Update File: docs/adr/1.md",
      "-## Not there",
      "+x",
    );
    expect(
      check(stale, { "docs/adr/1.md": ADR }).files[0]!.issues[0],
    ).toMatchObject({ code: "unreconstructable" });
    const absent = patch("*** Update File: docs/adr/2.md", "-a", "+b");
    expect(check(absent).files[0]!.issues[0]).toMatchObject({
      code: "unreconstructable",
      message: "the file doesn't exist",
    });
  });

  test("a patch touching a protected file is denied as a whole", () => {
    const request = patch(
      "*** Add File: src/ok.ts",
      "+x",
      "*** Update File: data/customers.md",
      "-a",
      "+b",
    );
    const result = check(
      request,
      { "data/customers.md": "a\n" },
      { isProtected: (path) => path.startsWith("data/") },
    );
    expect(result).toMatchObject({
      decision: "deny",
      files: [
        { outcome: "not-governed" },
        { outcome: "fail", issues: [{ code: "protected" }] },
      ],
    });
  });

  test("a rename into a contract folder validates the result there", () => {
    const draft = "## Context\n\nc\n\n## Decision\n\nd\n";
    const request = patch(
      "*** Update File: drafts/adr.md",
      "*** Move to: docs/adr/0013.md",
      "@@",
      " d",
      "+",
      "+## Consequences",
      "+",
      "+e",
    );
    const allowed = check(request, {
      "drafts/adr.md": `---\nstatus: proposed\ndate: "2026-11-21"\n---\n\n${draft}`,
    });
    expect(allowed).toMatchObject({
      decision: "allow",
      files: [
        {
          path: "docs/adr/0013.md",
          from: "drafts/adr.md",
          operation: "move",
          contracts: ["adr"],
        },
      ],
    });
    const missing = patch(
      "*** Update File: drafts/adr.md",
      "*** Move to: docs/adr/0013.md",
      "@@",
      "-d",
      "+D",
    );
    expect(check(missing, { "drafts/adr.md": draft })).toMatchObject({
      decision: "deny",
    });
  });

  test("a content contract never authorizes a delete or a move out", () => {
    expect(
      check(patch("*** Delete File: docs/adr/1.md"), { "docs/adr/1.md": ADR }),
    ).toMatchObject({
      decision: "deny",
      files: [
        {
          operation: "delete",
          contracts: ["adr"],
          issues: [{ code: "delete" }],
        },
      ],
    });
    const out = patch(
      "*** Update File: docs/adr/1.md",
      "*** Move to: archive/1.md",
      "-## Context",
      "+## Background",
    );
    expect(
      check(out, { "docs/adr/1.md": ADR }).files[0]!.issues,
    ).toContainEqual(expect.objectContaining({ code: "delete" }));
    // Deleting an ungoverned file, present or not, is someone else's check.
    expect(
      check(patch("*** Delete File: src/a.ts"), { "src/a.ts": "x" }).decision,
    ).toBe("not-governed");
    expect(check(patch("*** Delete File: src/a.ts")).decision).toBe(
      "not-governed",
    );
  });

  test("an Add File over an existing file is an update", () => {
    expect(
      check(patch("*** Add File: memory/a.md", ...added(NOTE)), {
        "memory/a.md": "old",
      }).files[0]!.operation,
    ).toBe("update");
  });

  test("one file named twice, or a bad patch, refuses the whole request", () => {
    const twice = patch(
      "*** Add File: memory/a.md",
      "+x",
      "*** Delete File: Memory/A.md",
    );
    expect(check(twice)).toMatchObject({
      decision: "deny",
      files: [],
      reason: "the write is refused: the request touches one file twice",
    });
    expect(check({ tool: "patch", patch: "nonsense" })).toMatchObject({
      decision: "deny",
      reason: expect.stringContaining("Begin Patch"),
    });
    expect(check(patch("*** Add File: ../x.md", "+x")).decision).toBe("deny");
  });

  test("relative patch paths resolve against cwd", () => {
    const plan = planWrite(patch("*** Add File: a.md", "+x"), {
      projectRoot: ROOT,
      cwd: `${ROOT}/memory`,
      current: () => ({ state: "absent" }),
    });
    expect(plan).toMatchObject({
      ok: true,
      changes: [{ path: "memory/a.md", operation: "create", content: "x\n" }],
    });
  });
});

test("planning rethrows what isn't a refusal", () => {
  const boom = () => {
    throw new Error("disk");
  };
  expect(() =>
    planWrite(
      { tool: "write", path: `${ROOT}/a.md`, content: "" },
      { projectRoot: ROOT, cwd: ROOT, current: boom },
    ),
  ).toThrow("disk");
});
