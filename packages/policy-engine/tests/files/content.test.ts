// File-content contracts: complete files read against their
// contract. Every artifact the wave names has a valid fixture and rejected
// ones; byte, encoding, YAML and Markdown edge cases follow.
import { describe, expect, test } from "vitest";
import {
  FILE_LIMITS,
  readFileContent,
  readStructure,
  readText,
  unsafeLink,
  type FileContract,
} from "../../src/files/index";
import { contract, fixture, fixtures } from "./support";

/** Where each artifact's fixtures sit in a project, and the issue each rejected one must give. */
const ARTIFACTS: Record<
  string,
  { path: string; rejected: Record<string, [string, string]> }
> = {
  memory: {
    path: "memory/root-cause.md",
    rejected: {
      "invalid-duplicate-key.md": ["frontmatter", "parse"],
      "invalid-kind.md": ["frontmatter.type", "enum"],
      "invalid-missing-field.md": ["frontmatter.description", "required"],
      "invalid-no-frontmatter.md": ["frontmatter", "required"],
    },
  },
  adr: {
    path: "docs/adr/0012-file-contracts.md",
    rejected: {
      "invalid-date.md": ["frontmatter.date", "type"],
      "invalid-duplicate-section.md": ["sections.Decision", "duplicate"],
      "invalid-hidden-section.md": ["sections.Consequences", "required"],
      "invalid-missing-section.md": ["sections.Consequences", "required"],
    },
  },
  handoff: {
    path: "notes/handovers/wave-4/HANDOVER.md",
    rejected: {
      "invalid-case.md": ["sections.Next steps", "heading"],
      "invalid-frontmatter.md": ["frontmatter", "unexpected"],
      "invalid-setext.md": ["sections.State", "heading"],
    },
  },
  lesson: {
    path: "memory/lessons/env-local.md",
    rejected: {
      "invalid-kind.md": ["frontmatter.kind", "enum"],
      "invalid-unknown-tag.md": ["frontmatter", "parse"],
    },
  },
  eval: {
    path: "evals/runs/2026-11-21.md",
    rejected: {
      "invalid-quoted-number.md": ["frontmatter.score", "type"],
      "invalid-range.md": ["frontmatter.score", "above"],
    },
  },
  "pr-body": {
    path: ".github/pr-bodies/dc-04-2.md",
    rejected: {
      "invalid-traversal-link.md": ["line 3", "unsafe-link"],
      "invalid-unsafe-link.md": ["line 3", "unsafe-link"],
    },
  },
  tracker: {
    path: "tracker/issues/120.md",
    rejected: {
      "invalid-fenced-section.md": ["sections.Acceptance", "required"],
      "invalid-unknown-key.md": ["frontmatter.assignee", "unknown"],
    },
  },
};

describe("every artifact has valid and rejected fixtures", () => {
  for (const [artifact, { path, rejected }] of Object.entries(ARTIFACTS)) {
    const files = fixtures(artifact);
    test(`${artifact}: fixtures are all listed`, () => {
      expect(files.some((file) => file.valid)).toBe(true);
      expect(
        files.filter((file) => !file.valid).map((file) => file.name),
      ).toEqual(Object.keys(rejected).sort());
    });
    for (const file of files)
      test(`${artifact}/${file.name}`, () => {
        const reading = readFileContent(contract(artifact), file.text, path);
        if (file.valid) {
          expect(reading).toMatchObject({ state: "valid", contract: artifact });
          return;
        }
        expect(reading.state).toBe("invalid");
        if (reading.state !== "invalid") return;
        const [at, code] = rejected[file.name]!;
        expect(reading.issues).toContainEqual(
          expect.objectContaining({ path: at, code }),
        );
        // Issues never echo the content.
        expect(JSON.stringify(reading)).not.toMatch(
          /someone|rule|alert|passwd|0\.95/,
        );
      });
  }
});

describe("a valid reading is typed", () => {
  test("ADR: frontmatter, sections and headings", () => {
    const reading = readFileContent(
      contract("adr"),
      fixture("adr", "valid.md"),
      ARTIFACTS.adr!.path,
    );
    expect(reading.state).toBe("valid");
    if (reading.state !== "valid") return;
    expect(reading.frontmatter).toEqual({
      status: "accepted",
      date: "2026-11-21",
      deciders: ["alex"],
    });
    expect(Object.keys(reading.sections)).toEqual([
      "Context",
      "Decision",
      "Consequences",
    ]);
    // The section runs to the next level-2 heading; a fenced heading and a level-3 one stay inside.
    expect(reading.sections.Decision!.text).toContain("### Alternatives");
    expect(reading.sections.Decision!.text).toContain(
      "A heading inside a code block",
    );
    expect(reading.sections.Consequences!.text).toBe(
      "Writes whose result can't be reconstructed are refused for governed files.",
    );
    expect(reading.headings.map((h) => [h.level, h.text])).toEqual([
      [1, "ADR 0012: File contracts validate the complete result"],
      [2, "Context"],
      [2, "Decision"],
      [2, "Consequences"],
    ]);
    expect(reading.bytes).toBe(Buffer.byteLength(fixture("adr", "valid.md")));
  });

  test("HANDOFF: optional section present, closing #s, no frontmatter", () => {
    const text = `${fixture("handoff", "valid.md")}\n## Goal ##\n`.replace(
      "## Goal ##\n",
      "",
    );
    const reading = readFileContent(
      contract("handoff"),
      text,
      ARTIFACTS.handoff!.path,
    );
    expect(reading).toMatchObject({ state: "valid", frontmatter: null });
    if (reading.state === "valid")
      expect(Object.keys(reading.sections)).toContain("Open questions");
    const closed = readFileContent(
      contract("handoff"),
      "## Goal ##\n\n## State #\n\n## Next steps\n",
      "x",
    );
    expect(closed.state).toBe("valid");
  });

  test("an optional section may be missing", () => {
    const text = fixture("pr-body", "valid.md");
    expect(text).not.toContain("## Risks");
    expect(
      readFileContent(contract("pr-body"), text, ARTIFACTS["pr-body"]!.path)
        .state,
    ).toBe("valid");
  });
});

describe("bytes and encoding", () => {
  const memory = fixture("memory", "valid.md");
  const read = (
    content: string | Uint8Array,
    against: FileContract = contract("memory"),
  ) => readFileContent(against, content, "memory/x.md");
  const code = (content: string | Uint8Array, against?: FileContract) => {
    const reading = read(content, against);
    return reading.state === "invalid" ? reading.issues[0]!.code : "valid";
  };

  test("valid UTF-8 bytes read like the string", () => {
    expect(read(new TextEncoder().encode(memory))).toEqual(read(memory));
    expect(
      code(new TextEncoder().encode(memory.replace("faster", "faster — ✓ 🚀"))),
    ).toBe("valid");
  });

  test.each([
    [
      "invalid UTF-8 bytes",
      Uint8Array.from([...new TextEncoder().encode(memory), 0xc3, 0x28]),
      "encoding",
    ],
    [
      "a byte-order mark",
      Uint8Array.from([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(memory)]),
      "bom",
    ],
    ["a lone surrogate", `${memory}\uD800`, "encoding"],
    ["a BOM in a string", `\uFEFF${memory}`, "bom"],
    ["a BOM inside", memory.replace("When", "\uFEFFWhen"), "bom"],
    ["a NUL", memory.replace("When", "\u0000When"), "control"],
    ["an escape", memory.replace("When", "\u001b[31mWhen"), "control"],
    ["a line separator", memory.replace("When", "\u2028When"), "control"],
    ["a bidi override", memory.replace("When", "\u202EWhen"), "bidi"],
    ["a CR line end", memory.replace("\n\nWhen", "\r\rWhen"), "line-ending"],
  ])("%s is refused", (_name, content, expected) => {
    expect(code(content)).toBe(expected);
  });

  test("CRLF files read like LF ones", () => {
    const crlf = memory.replace(/\n/g, "\r\n");
    expect(read(crlf)).toMatchObject({
      state: "valid",
      frontmatter: { type: "feedback" },
    });
  });

  test("size counts UTF-8 bytes of the complete file, against max_bytes", () => {
    const evalContract = contract("eval");
    expect(evalContract.maxBytes).toBe(4096);
    const base = fixture("eval", "valid.md");
    const fits = base + "x".repeat(4096 - Buffer.byteLength(base));
    expect(code(fits, evalContract)).toBe("valid");
    expect(code(`${fits}x`, evalContract)).toBe("size");
    // Three bytes each: the character count is under the limit, the bytes aren't.
    expect(code(base + "€".repeat(1400), evalContract)).toBe("size");
    expect(code(new TextEncoder().encode(`${fits}x`), evalContract)).toBe(
      "size",
    );
    expect(code("x".repeat(FILE_LIMITS.maxBytes + 1), evalContract)).toBe(
      "size",
    );
  });

  test("the default size is 64 KiB", () => {
    expect(contract("memory").maxBytes).toBe(64 * 1024);
    expect(readText("x".repeat(10), 5)).toMatchObject({
      ok: false,
      issue: { code: "size" },
    });
  });
});

describe("frontmatter", () => {
  const note = (yaml: string) => `---\n${yaml}\n---\n\nBody.\n`;
  const issues = (text: string, against = contract("memory")) => {
    const reading = readFileContent(against, text, "memory/x.md");
    return reading.state === "invalid"
      ? reading.issues.map((i) => `${i.path}:${i.code}`)
      : [];
  };
  const fields = "name: n\ndescription: d\ntype: user";

  test.each([
    ["unclosed", `---\n${fields}\n\nBody.\n`, "frontmatter:unclosed"],
    ["not a map", note("- a\n- b"), "frontmatter:type"],
    ["empty", "---\n---\nBody.\n", "frontmatter:type"],
    ["bad YAML", note("name: [unclosed"), "frontmatter:parse"],
    [
      "an alias bomb",
      note(
        `a: &a [x, x, x, x, x, x, x, x, x, x]\n${Array.from({ length: 60 }, (_, i) => `k${i}: *a`).join("\n")}`,
      ),
      "frontmatter:parse",
    ],
    [
      "over 16 KiB",
      note(`${fields}\npad: ${"x".repeat(FILE_LIMITS.frontmatterBytes)}`),
      "frontmatter:size",
    ],
    [
      "a date not quoted stays a string",
      note(`${fields}\nextra: 2026-01-01`),
      "frontmatter.extra:unknown",
    ],
  ])("%s", (_name, text, expected) => {
    expect(issues(text)).toContain(expected);
  });

  test("the frontmatter must open the file", () => {
    expect(issues(`\n${note(fields)}`)).toContain("frontmatter:required");
  });

  test("a valid note's values keep their types", () => {
    const reading = readFileContent(
      contract("eval"),
      fixture("eval", "valid.md"),
      "evals/runs/a.md",
    );
    expect(reading).toMatchObject({
      state: "valid",
      frontmatter: { score: 0.95, passed: true },
    });
  });

  test("an issue list is bounded", () => {
    const many = Array.from({ length: 40 }, (_, i) => `k${i}: 1`).join("\n");
    const reading = readFileContent(
      contract("memory"),
      note(many),
      "memory/x.md",
    );
    expect(reading.state === "invalid" && reading.issues.length).toBe(20);
  });
});

describe("Markdown structure", () => {
  const headings = (text: string) =>
    readStructure(text).headings.map(
      (h) => `${h.level}${h.setext ? "s" : ""}:${h.text}`,
    );

  test("only level-1 and level-2 headings outside code and comments", () => {
    const text = [
      "# Title",
      "##NoSpace",
      "    ## Indented code",
      "   ## Three spaces",
      "### Three",
      "```js ```",
      "## not a fence: backtick in info string",
      "````",
      "## Fenced",
      "```",
      "## Still fenced",
      "````",
      "~~~",
      "## Tilde fenced",
      "~~~",
      "<!-- ## Inline comment -->",
      "<!--",
      "## Commented",
      "-->",
      "> ## Quoted",
      "- ## Listed",
      "## Closing ###",
      "## \\#",
      "##",
    ].join("\n");
    expect(headings(text)).toEqual([
      "1:Title",
      "2:Three spaces",
      "2:not a fence: backtick in info string",
      "2:Closing",
      "2:\\#",
      "2:",
    ]);
  });

  test("setext headings, and what isn't one", () => {
    const text = [
      "Title",
      "=====",
      "",
      "Two lines",
      "of heading",
      "---",
      "",
      "- item",
      "---",
      "",
      "    code",
      "---",
      "",
      "## After",
      "---",
    ].join("\n");
    expect(headings(text)).toEqual([
      "1s:Title",
      "2s:Two lines\nof heading",
      "2:After",
    ]);
  });

  test("an unclosed fence hides the rest of the file", () => {
    expect(headings("## A\n```\n## B\n")).toEqual(["2:A"]);
  });

  test("too many headings is refused", () => {
    const text = Array.from(
      { length: FILE_LIMITS.headings + 1 },
      (_, i) => `## H${i}`,
    ).join("\n");
    const reading = readFileContent(
      contract("pr-body"),
      text,
      ".github/pr-bodies/x.md",
    );
    expect(reading).toMatchObject({
      state: "invalid",
      issues: [{ code: "too-many" }],
    });
  });
});

describe("links", () => {
  test.each([
    ["#anchor", null],
    ["", null],
    ["https://example.com/a?b#c", null],
    ["HTTP://EXAMPLE.COM", null],
    ["mailto:a@b.c", null],
    ["//cdn.example.com/x.png", null],
    ["./sibling.md", null],
    ["../../README.md", null],
    ["/docs/x.md", null],
    ["../../../x.md", "points outside the project"],
    ["/../x", "points outside the project"],
    ["..%2F..%2F..%2Fx", "points outside the project"],
    ["javascript:alert(1)", "uses a scheme other than http, https or mailto"],
    ["JaVaScRiPt:x", "uses a scheme other than http, https or mailto"],
    ["java%0Ascript:x", "uses a scheme other than http, https or mailto"],
    ["data:text/html,x", "uses a scheme other than http, https or mailto"],
    ["file:///etc/passwd", "uses a scheme other than http, https or mailto"],
    ["vbscript:x", "uses a scheme other than http, https or mailto"],
    ["..\\..\\x", "uses a backslash"],
    ["%E0%A4%A", "has an undecodable escape"],
  ])("%s", (destination, expected) => {
    expect(unsafeLink(destination, "docs/adr/x.md")).toBe(expected);
  });

  test("every place a link hides is read, but not code blocks or comments", () => {
    const against = contract("pr-body");
    const body = (extra: string) =>
      `## Summary\n\n${extra}\n\n## Test plan\n\nok\n`;
    const bad = [
      "[a](javascript:x)",
      "![i](<javascript:x>)",
      "<javascript:x>",
      '<a href="javascript:x">a</a>',
      "<img src='data:x'>",
      "[r]: javascript:x",
    ];
    for (const extra of bad)
      expect(
        readFileContent(against, body(extra), ".github/pr-bodies/x.md").state,
        extra,
      ).toBe("invalid");
    for (const extra of [
      "```\n[a](javascript:x)\n```",
      "<!-- [a](javascript:x) -->",
    ])
      expect(
        readFileContent(against, body(extra), ".github/pr-bodies/x.md").state,
        extra,
      ).toBe("valid");
  });

  test("too many links is refused rather than skipped", () => {
    const links = Array.from(
      { length: FILE_LIMITS.links + 1 },
      () => "[a](#a)",
    ).join(" ");
    const reading = readFileContent(
      contract("pr-body"),
      `## Summary\n\n${links}\n\n## Test plan\n`,
      "x.md",
    );
    expect(reading).toMatchObject({
      state: "invalid",
      issues: [{ path: "(links)", code: "too-many" }],
    });
  });
});
