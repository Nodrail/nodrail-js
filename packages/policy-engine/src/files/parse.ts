// A complete file read against its contract (S07): bytes and encoding, the
// frontmatter as bounded YAML (core schema, unique keys, no unknown tags)
// checked by the one shape validator, level-2 sections matched by exact
// trimmed text, and links. Every problem is reported, up to a bound; an
// invalid file has no usable value. Issues never echo content.
import { parseDocument } from "yaml";
import { validateValue } from "../shapes/validate.ts";
import type { FileContract } from "./contracts.ts";
import { FILE_LIMITS } from "./limits.ts";
import { linkIssues } from "./links.ts";
import {
  readStructure,
  sectionText,
  type Heading,
  type Structure,
} from "./markdown.ts";
import { readText, utf8Bytes, type FileIssue } from "./text.ts";

export type FileSection = {
  name: string;
  /** 1-based line of its heading. */
  line: number;
  /** The text under it, blank lines around it dropped. */
  text: string;
};

export type FileReading =
  | {
      state: "valid";
      contract: string;
      bytes: number;
      /** Validated against the contract's frontmatter shape; null without one. */
      frontmatter: Record<string, unknown> | null;
      /** Each declared section the file has, by declared name. */
      sections: Record<string, FileSection>;
      /** Every level-1 and level-2 heading, declared or not. */
      headings: Pick<Heading, "level" | "text" | "line">[];
    }
  | {
      state: "invalid";
      contract: string;
      /** The first issue, as one safe sentence. */
      reason: string;
      issues: FileIssue[];
    };

const MAX_ISSUES = 20;

const issue = (path: string, code: string, message: string): FileIssue => ({
  path,
  code,
  message,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The frontmatter value, or the issues that leave it unusable. */
function frontmatterValue(
  contract: FileContract,
  structure: Structure,
): { value: Record<string, unknown> | null; issues: FileIssue[] } {
  const { frontmatter } = structure;
  const none = { value: null, issues: [] };
  if (frontmatter.state === "unclosed")
    return {
      value: null,
      issues: [
        issue("frontmatter", "unclosed", "the --- block has no closing ---"),
      ],
    };
  if (!contract.frontmatter)
    return frontmatter.state === "none"
      ? none
      : {
          value: null,
          issues: [
            issue(
              "frontmatter",
              "unexpected",
              "the contract declares no frontmatter",
            ),
          ],
        };
  if (frontmatter.state === "none")
    return {
      value: null,
      issues: [
        issue("frontmatter", "required", "expected a leading --- block"),
      ],
    };
  if (utf8Bytes(frontmatter.block) > FILE_LIMITS.frontmatterBytes)
    return {
      value: null,
      issues: [
        issue(
          "frontmatter",
          "size",
          `expected at most ${FILE_LIMITS.frontmatterBytes} bytes`,
        ),
      ],
    };
  const document = parseDocument(frontmatter.yaml, {
    schema: "core",
    uniqueKeys: true,
    prettyErrors: false,
  });
  // Bad YAML, a key given twice, an unknown tag: never read past.
  if (document.errors.length || document.warnings.length)
    return {
      value: null,
      issues: [
        issue("frontmatter", "parse", "isn't valid YAML in the core schema"),
      ],
    };
  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: FILE_LIMITS.aliases });
  } catch {
    return {
      value: null,
      issues: [issue("frontmatter", "parse", "expands too many aliases")],
    };
  }
  if (!isRecord(value))
    return {
      value: null,
      issues: [issue("frontmatter", "type", "expected a map of fields")],
    };
  const issues = validateValue(contract.frontmatter, value).map((found) =>
    issue(
      found.path === "(value)" ? "frontmatter" : `frontmatter.${found.path}`,
      found.code,
      found.message,
    ),
  );
  return { value, issues };
}

const key = (name: string) => name.normalize("NFC").toLowerCase();

/** Declared sections: each present exactly once, by exact text, unless optional. */
function sectionIssues(contract: FileContract, headings: Heading[]) {
  const issues: FileIssue[] = [];
  for (const rule of contract.sections) {
    const at = `sections.${rule.name}`;
    const near = headings.filter((h) => key(h.text) === key(rule.name));
    const exact = near.filter(
      (h) => h.level === 2 && !h.setext && h.text === rule.name,
    );
    if (near.length > 1)
      issues.push(issue(at, "duplicate", "appears more than once"));
    else if (near.length === 1 && exact.length === 0)
      issues.push(
        issue(
          at,
          "heading",
          "a heading has this name but isn't `## ` with the exact text",
        ),
      );
    else if (exact.length === 0 && !rule.optional)
      issues.push(issue(at, "required", "expected a `## ` heading"));
  }
  return issues;
}

function sections(contract: FileContract, structure: Structure) {
  const found: Record<string, FileSection> = {};
  for (const rule of contract.sections) {
    const heading = structure.headings.find(
      (h) => h.level === 2 && !h.setext && h.text === rule.name,
    );
    if (heading)
      found[rule.name] = {
        name: rule.name,
        line: heading.line,
        text: sectionText(structure, heading),
      };
  }
  return found;
}

const invalid = (contract: FileContract, issues: FileIssue[]): FileReading => {
  const kept = issues.slice(0, MAX_ISSUES);
  const first = kept[0]!;
  return {
    state: "invalid",
    contract: contract.name,
    reason: `${first.path}: ${first.message}`,
    issues: kept,
  };
};

/**
 * A complete proposed file read against a contract. `path` is the file's
 * project-relative path, which relative links resolve against.
 */
export function readFileContent(
  contract: FileContract,
  content: string | Uint8Array,
  path: string,
): FileReading {
  const text = readText(content, contract.maxBytes);
  if (!text.ok) return invalid(contract, [text.issue]);
  const structure = readStructure(
    text.crlf ? text.text.replace(/\r\n/g, "\n") : text.text,
  );
  if (structure.headings.length > FILE_LIMITS.headings)
    return invalid(contract, [
      issue(
        "(headings)",
        "too-many",
        `expected at most ${FILE_LIMITS.headings} headings`,
      ),
    ]);
  const frontmatter = frontmatterValue(contract, structure);
  const issues = [
    ...frontmatter.issues,
    ...sectionIssues(contract, structure.headings),
    ...linkIssues(structure, path),
  ];
  if (issues.length) return invalid(contract, issues);
  return {
    state: "valid",
    contract: contract.name,
    bytes: text.bytes,
    frontmatter: frontmatter.value,
    sections: sections(contract, structure),
    headings: structure.headings.map(({ level, text: name, line }) => ({
      level,
      text: name,
      line,
    })),
  };
}
