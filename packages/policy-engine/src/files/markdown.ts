// The Markdown structure a file contract reads, and nothing more: the
// leading `---` frontmatter block, level-1 and level-2 headings outside
// fenced code and HTML comments, where sections start and end, and the
// prose lines links are read from. Works on LF text; lines are numbered
// from 1 in the whole file, frontmatter included.

export type Heading = {
  level: 1 | 2;
  /** Trimmed, closing `#`s removed: what a section name is matched against. */
  text: string;
  /** 1-based line where the heading starts. */
  line: number;
  /** 1-based line where it ends: the underline of a setext heading. */
  last: number;
  /** Written as a line underlined with `=` or `-`. */
  setext: boolean;
};

export type Frontmatter =
  | { state: "none" }
  | { state: "unclosed" }
  | {
      state: "present";
      /** The YAML between the fences. */
      yaml: string;
      /** The block with its fences, as written. */
      block: string;
    };

export type Structure = {
  frontmatter: Frontmatter;
  headings: Heading[];
  /** Every line of the file; `prose[i]` says whether line i+1 is rendered text. */
  lines: string[];
  prose: boolean[];
};

const FENCE_LINE = /^---[ \t]*$/;
const CODE_FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const ATX = /^ {0,3}(#{1,6})(?=[ \t]|$)(.*)$/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const COMMENT_OPEN = /^ {0,3}<!--/;
const LIST_OR_QUOTE = /^ {0,3}(?:[-+*>]|\d{1,9}[.)])(?:[ \t]|$)/;

function splitFrontmatter(lines: string[]): {
  frontmatter: Frontmatter;
  body: number;
} {
  if (!FENCE_LINE.test(lines[0] ?? ""))
    return { frontmatter: { state: "none" }, body: 0 };
  const end = lines.findIndex(
    (line, index) => index > 0 && FENCE_LINE.test(line),
  );
  if (end < 0)
    return { frontmatter: { state: "unclosed" }, body: lines.length };
  return {
    frontmatter: {
      state: "present",
      yaml: lines.slice(1, end).join("\n"),
      block: lines.slice(0, end + 1).join("\n"),
    },
    body: end + 1,
  };
}

/** Heading text as CommonMark reads it: trimmed, with any closing `#`s dropped. */
function atxText(rest: string) {
  return rest
    .trim()
    .replace(/(?:^|[ \t]+)#+$/, "")
    .trim();
}

type Fence = { char: string; length: number } | null;

/** The fence a line closes or opens; `inside` is the fence already open. */
function fenceAt(line: string, inside: Fence): { fence: Fence; code: boolean } {
  const match = CODE_FENCE.exec(line);
  if (inside) {
    const closes =
      match &&
      match[1]![0] === inside.char &&
      match[1]!.length >= inside.length &&
      !match[2]!.trim();
    return { fence: closes ? null : inside, code: true };
  }
  // A backtick fence's info string can't hold a backtick.
  if (!match || (match[1]![0] === "`" && match[2]!.includes("`")))
    return { fence: null, code: false };
  return {
    fence: { char: match[1]![0]!, length: match[1]!.length },
    code: true,
  };
}

type Scan = {
  fence: Fence;
  comment: boolean;
  /** Open paragraph text a setext underline would turn into a heading. */
  paragraph: { text: string; line: number } | null;
};

/** Whether the line is hidden in code or a comment, updating the scan. */
function hidden(line: string, scan: Scan) {
  if (scan.comment) {
    if (line.includes("-->")) scan.comment = false;
    return true;
  }
  const fence = fenceAt(line, scan.fence);
  if (fence.code) {
    scan.fence = fence.fence;
    return true;
  }
  if (COMMENT_OPEN.test(line)) {
    scan.comment = !line.slice(line.indexOf("<!--") + 4).includes("-->");
    return true;
  }
  return false;
}

/** Keeps track of the paragraph a later underline could make a heading. */
function follow(line: string, number: number, scan: Scan) {
  const text = line.trim();
  if (!text || LIST_OR_QUOTE.test(line)) scan.paragraph = null;
  else if (scan.paragraph)
    scan.paragraph = {
      ...scan.paragraph,
      text: `${scan.paragraph.text}\n${text}`,
    };
  else if (!/^(?: {4}|\t)/.test(line)) scan.paragraph = { text, line: number };
}

function headingAt(line: string, number: number, scan: Scan): Heading | null {
  const atx = ATX.exec(line);
  if (atx) {
    scan.paragraph = null;
    const level = atx[1]!.length;
    if (level > 2) return null;
    const text = atxText(atx[2]!);
    return {
      level: level as 1 | 2,
      text,
      line: number,
      last: number,
      setext: false,
    };
  }
  const setext = SETEXT.exec(line);
  if (setext && scan.paragraph) {
    const { text, line: start } = scan.paragraph;
    scan.paragraph = null;
    const level = setext[1]![0] === "=" ? 1 : 2;
    return { level, text, line: start, last: number, setext: true };
  }
  follow(line, number, scan);
  return null;
}

/** The structure of LF text. */
export function readStructure(text: string): Structure {
  const lines = text.split("\n");
  const { frontmatter, body } = splitFrontmatter(lines);
  const prose = lines.map(() => false);
  const headings: Heading[] = [];
  const scan: Scan = { fence: null, comment: false, paragraph: null };
  for (let index = body; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (hidden(line, scan)) {
      scan.paragraph = null;
      continue;
    }
    prose[index] = true;
    const heading = headingAt(line, index + 1, scan);
    if (heading) headings.push(heading);
  }
  return { frontmatter, headings, lines, prose };
}

/**
 * The text under a heading, up to the next level-1 or level-2 heading or
 * the end of the file. Leading and trailing blank lines are dropped.
 */
export function sectionText(structure: Structure, heading: Heading) {
  const { lines, headings } = structure;
  const start = heading.last;
  const next = headings.find((other) => other.line > heading.line);
  const end = next ? next.line - 1 : lines.length;
  return lines
    .slice(start, end)
    .join("\n")
    .replace(/^(?:[ \t]*\n)+/, "")
    .replace(/\s+$/, "");
}
