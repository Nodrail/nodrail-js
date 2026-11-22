// Links in a contracted file: every destination Markdown or HTML would
// follow, read from rendered lines only. A link is safe when it is a
// fragment, an http(s) or mailto URL, or a relative path that stays inside
// the project. Anything else (javascript:, data:, file:, a backslash path,
// `..` past the project root, an undecodable escape) is refused, never
// rewritten. Issues say why and on which line, never the destination.
import { posix } from "node:path";
import { FILE_LIMITS } from "./limits.ts";
import type { Structure } from "./markdown.ts";
import type { FileIssue } from "./text.ts";

/** Inline links and images: `](dest` with an optional `<`. */
const INLINE = /\]\(\s*<?([^\s)>]*)/g;
/** Reference definitions: `[label]: dest`. */
const DEFINITION = /^ {0,3}\[[^\]]+\]:[ \t]*<?([^\s>]+)/;
/** Autolinks: `<scheme:...>`. */
const AUTOLINK = /<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*)>/g;
/** HTML attributes that load or navigate. */
const ATTRIBUTE =
  /\b(?:href|src|srcset|action|formaction|poster|data|xlink:href)\s*=\s*["']?([^"'\s>]+)/gi;

const SAFE_SCHEMES = new Set(["http", "https", "mailto"]);
const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):/;

/** Every destination on one line. */
function destinations(line: string) {
  const found: string[] = [];
  for (const pattern of [INLINE, AUTOLINK, ATTRIBUTE])
    for (const match of line.matchAll(pattern)) found.push(match[1]!);
  const definition = DEFINITION.exec(line);
  if (definition) found.push(definition[1]!);
  return found;
}

function decoded(destination: string) {
  try {
    return decodeURIComponent(destination);
  } catch {
    return null;
  }
}

/**
 * Why a destination is unsafe for a file at `path` (project-relative), or
 * null when it is safe.
 */
export function unsafeLink(destination: string, path: string): string | null {
  const text = decoded(destination);
  if (text === null) return "has an undecodable escape";
  // Browsers drop these inside a scheme: `java\tscript:` is still javascript.
  // oxlint-disable-next-line no-control-regex -- the point is to remove them
  const plain = text.replace(/[\s\u0000-\u001F]/g, "");
  if (!plain || plain.startsWith("#")) return null;
  const scheme = SCHEME.exec(plain)?.[1]?.toLowerCase();
  if (scheme !== undefined)
    return SAFE_SCHEMES.has(scheme)
      ? null
      : "uses a scheme other than http, https or mailto";
  if (plain.includes("\\")) return "uses a backslash";
  if (plain.startsWith("//")) return null;
  const target = plain.replace(/[?#].*$/, "");
  const from = plain.startsWith("/") ? "." : posix.dirname(path);
  const resolved = posix.normalize(
    posix.join(from, target.replace(/^\/+/, "")),
  );
  if (resolved === ".." || resolved.startsWith("../"))
    return "points outside the project";
  return null;
}

/** Issues for unsafe links on rendered lines; too many links is one issue. */
export function linkIssues(structure: Structure, path: string): FileIssue[] {
  const issues: FileIssue[] = [];
  let count = 0;
  for (const [index, line] of structure.lines.entries()) {
    if (!structure.prose[index]) continue;
    for (const destination of destinations(line)) {
      count += 1;
      if (count > FILE_LIMITS.links)
        return [
          ...issues,
          {
            path: "(links)",
            code: "too-many",
            message: `expected at most ${FILE_LIMITS.links} links`,
          },
        ];
      const reason = unsafeLink(destination, path);
      if (reason)
        issues.push({
          path: `line ${index + 1}`,
          code: "unsafe-link",
          message: `a link ${reason}`,
        });
    }
  }
  return issues;
}
