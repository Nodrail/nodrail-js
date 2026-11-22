// The complete file each supported write leaves (DC-04.2): Claude Code Write
// and Edit replayed as Claude Code applies them, and apply_patch parsed and
// applied with exact matching. What can't be known exactly is refused.
import { describe, expect, test } from "vitest";
import {
  applyClaudeEdit,
  applyClaudeWrite,
  applyUpdate,
  parsePatch,
  readWriteRequest,
  type PatchChunk,
} from "../../src/files/index";

const edit = (oldString: string, newString: string, replaceAll = false) => ({
  oldString,
  newString,
  replaceAll,
});

describe("Claude Code Edit", () => {
  test("replaces a unique fragment", () => {
    expect(applyClaudeEdit("a\nb\nc\n", edit("b", "B"))).toEqual({
      ok: true,
      content: "a\nB\nc\n",
    });
  });

  test("an ambiguous old_string is refused unless replace_all", () => {
    expect(applyClaudeEdit("x y x", edit("x", "z"))).toMatchObject({
      ok: false,
      code: "ambiguous",
    });
    expect(applyClaudeEdit("x y x", edit("x", "z", true))).toEqual({
      ok: true,
      content: "z y z",
    });
  });

  test("occurrences don't overlap", () => {
    expect(applyClaudeEdit("aaa", edit("aa", "b"))).toEqual({
      ok: true,
      content: "ba",
    });
  });

  test("replacement text is literal: no $& patterns", () => {
    expect(applyClaudeEdit("a", edit("a", "$&$&"))).toEqual({
      ok: true,
      content: "$&$&",
    });
  });

  test.each([
    ["missing text", "abc", edit("z", "y"), "not-found"],
    ["no change", "abc", edit("b", "b"), "no-change"],
    ["a missing file", null, edit("a", "b"), "missing"],
    ["creating over content", "abc", edit("", "new"), "exists"],
    [
      "curly quotes aren't straightened",
      "it’s",
      edit("it's", "it is"),
      "not-found",
    ],
  ])("%s is refused", (_name, current, change, code) => {
    expect(applyClaudeEdit(current, change)).toMatchObject({ ok: false, code });
  });

  test("an empty old_string creates a missing or empty file", () => {
    expect(applyClaudeEdit(null, edit("", "new"))).toEqual({
      ok: true,
      content: "new",
    });
    expect(applyClaudeEdit(" \n", edit("", "new"))).toEqual({
      ok: true,
      content: "new",
    });
  });

  test("deleting a fragment takes the newline after it", () => {
    expect(applyClaudeEdit("a\nb\nc\n", edit("b", ""))).toEqual({
      ok: true,
      content: "a\nc\n",
    });
    expect(applyClaudeEdit("a\nb\nc\n", edit("b\n", ""))).toEqual({
      ok: true,
      content: "a\nc\n",
    });
    expect(applyClaudeEdit("a b", edit(" b", ""))).toEqual({
      ok: true,
      content: "a",
    });
    expect(applyClaudeEdit("b\nxb\n", edit("b", "", true))).toEqual({
      ok: true,
      content: "x",
    });
  });

  test("CRLF files are matched as LF and written back as CRLF", () => {
    expect(applyClaudeEdit("a\r\nb\r\n", edit("a\nb", "a\nB"))).toEqual({
      ok: true,
      content: "a\r\nB\r\n",
    });
  });

  test("Write leaves exactly its content", () => {
    expect(applyClaudeWrite("x")).toEqual({ ok: true, content: "x" });
  });
});

const patch = (...lines: string[]) =>
  ["*** Begin Patch", ...lines, "*** End Patch"].join("\n");

describe("apply_patch: parsing", () => {
  test("add, delete, update and move in one patch", () => {
    const parsed = parsePatch(
      patch(
        "*** Add File: notes/a.md",
        "+alpha",
        "+",
        "*** Delete File: old.md",
        "*** Update File: docs/b.md",
        "*** Move to: docs/c.md",
        "@@ ## Decision",
        " keep",
        "-old",
        "+new",
        "",
        "@@",
        "-tail",
        "*** End of File",
      ),
    );
    expect(parsed).toEqual({
      ok: true,
      operations: [
        { kind: "add", path: "notes/a.md", content: "alpha\n\n" },
        { kind: "delete", path: "old.md" },
        {
          kind: "update",
          path: "docs/b.md",
          moveTo: "docs/c.md",
          chunks: [
            {
              context: "## Decision",
              oldLines: ["keep", "old", ""],
              newLines: ["keep", "new", ""],
              endOfFile: false,
            },
            {
              context: null,
              oldLines: ["tail"],
              newLines: [],
              endOfFile: true,
            },
          ],
        },
      ],
    });
  });

  test("the first hunk may omit @@, as the host allows", () => {
    expect(
      parsePatch(patch("*** Update File: a.md", "-x", "+y")),
    ).toMatchObject({ ok: true });
  });

  test("surrounding whitespace is trimmed", () => {
    expect(
      parsePatch(
        `\n  *** Begin Patch\n*** Delete File: a.md\n*** End Patch  \n\n`,
      ),
    ).toMatchObject({ ok: true });
  });

  test.each([
    ["no envelope", "*** Delete File: a.md", "grammar"],
    ["no end", "*** Begin Patch\n*** Delete File: a.md", "grammar"],
    ["empty", patch(), "grammar"],
    [
      "a heredoc wrapper",
      "<<'EOF'\n" + patch("*** Delete File: a.md") + "\nEOF",
      "grammar",
    ],
    ["an unknown operation", patch("*** Rename File: a.md"), "grammar"],
    ["a file with no name", patch("*** Delete File:   "), "grammar"],
    [
      "a move with no name",
      patch("*** Update File: a.md", "*** Move to: ", "-a"),
      "grammar",
    ],
    ["an update with no hunks", patch("*** Update File: a.md"), "grammar"],
    [
      "an empty hunk",
      patch("*** Update File: a.md", "@@", "@@", "-a"),
      "grammar",
    ],
    [
      "a second hunk without @@",
      patch("*** Update File: a.md", "-a", "*** End of File", "-b"),
      "grammar",
    ],
    [
      "a stray line after an add",
      patch("*** Add File: a.md", "+a", "stray"),
      "grammar",
    ],
    ["a malformed @@", patch("*** Update File: a.md", "@@x", "-a"), "grammar"],
    [
      "CRLF lines",
      patch("*** Delete File: a.md").replace(/\n/g, "\r\n"),
      "line-ending",
    ],
  ])("%s is refused", (_name, text, code) => {
    expect(parsePatch(text)).toMatchObject({ ok: false, code });
  });

  test("a stray line ends a hunk and is then refused", () => {
    expect(
      parsePatch(patch("*** Update File: a.md", "@@", "-a", "?x")),
    ).toMatchObject({ ok: false, code: "grammar", line: 5 });
  });

  test("size, file and hunk limits", () => {
    expect(parsePatch("x".repeat(1024 * 1024 + 1))).toMatchObject({
      ok: false,
      code: "size",
    });
    const files = Array.from(
      { length: 51 },
      (_, i) => `*** Delete File: f${i}.md`,
    );
    expect(parsePatch(patch(...files))).toMatchObject({
      ok: false,
      code: "size",
    });
    const hunks = Array.from({ length: 1001 }, () => ["@@", "-a"]).flat();
    expect(parsePatch(patch("*** Update File: a.md", ...hunks))).toMatchObject({
      ok: false,
      code: "size",
    });
  });
});

const chunk = (
  oldLines: string[],
  newLines: string[],
  more: Partial<PatchChunk> = {},
): PatchChunk => ({
  context: null,
  oldLines,
  newLines,
  endOfFile: false,
  ...more,
});

describe("apply_patch: updates", () => {
  test("hunks apply in order, each after the last", () => {
    const text = "x\na\nx\nb\n";
    expect(
      applyUpdate(text, [chunk(["x"], ["1"]), chunk(["x"], ["2"])]),
    ).toEqual({ ok: true, content: "1\na\n2\nb\n" });
  });

  test("an @@ line anchors the next hunk", () => {
    const text = "## A\nx\n## B\nx\n";
    expect(
      applyUpdate(text, [chunk(["x"], ["y"], { context: "## B" })]),
    ).toEqual({ ok: true, content: "## A\nx\n## B\ny\n" });
    expect(
      applyUpdate(text, [chunk(["x"], ["y"], { context: "## C" })]),
    ).toMatchObject({ ok: false, code: "not-found" });
  });

  test("an end-of-file hunk matches the end", () => {
    expect(
      applyUpdate("x\na\nx\n", [chunk(["x"], ["z"], { endOfFile: true })]),
    ).toEqual({ ok: true, content: "x\na\nz\n" });
  });

  test("pure additions go at the end; the result ends with a newline", () => {
    expect(applyUpdate("a", [chunk([], ["b"])])).toEqual({
      ok: true,
      content: "a\nb\n",
    });
    // A file ending in a blank line: the addition goes before it, as the host inserts.
    expect(applyUpdate("a\n\n", [chunk([], ["b"])])).toEqual({
      ok: true,
      content: "a\nb\n",
    });
  });

  test("a trailing empty context line may be dropped, as the host does", () => {
    expect(applyUpdate("a\nb\n", [chunk(["b", ""], ["c", ""])])).toEqual({
      ok: true,
      content: "a\nc\n",
    });
  });

  test("only exact matches: whitespace-fuzzy ones are refused", () => {
    expect(applyUpdate("a  \n", [chunk(["a"], ["b"])])).toMatchObject({
      ok: false,
      code: "not-found",
    });
    expect(applyUpdate("a\n", [chunk(["a", "b", "c"], ["d"])])).toMatchObject({
      ok: false,
    });
  });
});

describe("reading write requests from hook events", () => {
  test("Claude Code Write and Edit", () => {
    expect(
      readWriteRequest("claude", "Write", {
        file_path: "/p/a.md",
        content: "x",
      }),
    ).toEqual({
      state: "write",
      request: { tool: "write", path: "/p/a.md", content: "x" },
    });
    expect(
      readWriteRequest("claude", "Edit", {
        file_path: "/p/a.md",
        old_string: "a",
        new_string: "b",
      }),
    ).toEqual({
      state: "write",
      request: {
        tool: "edit",
        path: "/p/a.md",
        oldString: "a",
        newString: "b",
        replaceAll: false,
      },
    });
  });

  test("Copilot apply_patch is the raw text", () => {
    expect(
      readWriteRequest("copilot", "apply_patch", "*** Begin Patch"),
    ).toEqual({
      state: "write",
      request: { tool: "patch", patch: "*** Begin Patch" },
    });
  });

  test.each([
    ["claude", "Read", {}, "none"],
    ["claude", "MultiEdit", {}, "unsupported"],
    ["claude", "NotebookEdit", {}, "unsupported"],
    ["claude", "Write", "x", "invalid"],
    ["claude", "Write", { file_path: "a" }, "invalid"],
    [
      "claude",
      "Edit",
      { file_path: "a", old_string: 1, new_string: "b" },
      "invalid",
    ],
    [
      "claude",
      "Edit",
      { file_path: "a", old_string: "a", new_string: "b", replace_all: "yes" },
      "invalid",
    ],
    ["copilot", "apply_patch", { patch: "x" }, "invalid"],
    ["copilot", "str_replace", {}, "unsupported"],
    ["copilot", "bash", {}, "none"],
    ["codex", "apply_patch", "x", "unsupported"],
    ["codex", "shell", {}, "none"],
  ] as const)("%s %s → %s", (runtime, tool, input, state) => {
    expect(readWriteRequest(runtime, tool, input).state).toBe(state);
  });
});
