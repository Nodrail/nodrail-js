// File contracts (S07) as a check reads them, from a compiled workspace, and
// project paths: normalized, refused when ambiguous, and matched against a
// contract's root and pattern. Matching ignores case and Unicode form, as
// the file systems agents run on often do, so `Docs/ADR/X.MD` can't slip
// past a contract on `./docs/adr`: when in doubt a path is governed.
import { posix, win32 } from "node:path";
import { relativePath, withoutNamespace } from "../paths.ts";
import type { CompiledContracts } from "../shapes/compile.ts";
import type { ResolvedShape } from "../shapes/types.ts";
import { FILE_LIMITS } from "./limits.ts";

export type FileSectionRule = { name: string; optional: boolean };

export type FileContract = {
  /** The declared name: `files.<name>`. */
  name: string;
  /** The binding digest that pins root, pattern, sections and shape. */
  digest: string;
  /** Project-relative folder with no `./` or trailing slash; "" is the project. */
  root: string;
  pattern: string;
  frontmatter: ResolvedShape | null;
  sections: FileSectionRule[];
  /** UTF-8 bytes of the complete file. */
  maxBytes: number;
  /** Agents that may create or update a matching file; null: any agent. */
  writers: string[] | null;
};

type FileOptions = {
  root: string;
  pattern: string;
  sections: FileSectionRule[];
  max_bytes: number | null;
  writers: string[] | null;
};

const folder = (root: string) => root.replace(/^\.\/?/, "").replace(/\/+$/, "");

/** Every file contract of a compiled workspace, in declaration order. */
export function fileContracts(compiled: CompiledContracts): FileContract[] {
  return compiled.bindings
    .filter((binding) => binding.surface === "S07")
    .map((binding) => {
      const options = binding.options as FileOptions;
      return {
        name: binding.name.slice("file:".length),
        digest: binding.digest,
        root: folder(options.root),
        pattern: options.pattern,
        frontmatter: binding.shape
          ? (compiled.shapes[binding.shape]?.shape ?? null)
          : null,
        sections: options.sections,
        maxBytes: options.max_bytes ?? FILE_LIMITS.defaultBytes,
        writers: options.writers,
      };
    });
}

export type PathResult =
  | { ok: true; path: string }
  | { ok: false; code: "outside" | "unsafe-path"; message: string };

/** Characters no project path needs. */
// oxlint-disable-next-line no-control-regex -- the point is to find them
const UNSAFE_CHARS = /[\u0000-\u001F\u007F]/;

const unsafe = (message: string): PathResult => ({
  ok: false,
  code: "unsafe-path",
  message,
});

/** The host path flavor follows the absolute project root, even off-host. */
export const projectFlavor = (root: string) =>
  posix.isAbsolute(root) && !root.startsWith("//") ? posix : win32;

function unsafeWindowsPart(part: string) {
  // Win32 aliases trailing dots/spaces and devices. Colons also name streams.
  return (
    /[:*?"<>|]|[. ]$/.test(part) ||
    /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(part)
  );
}

export function absoluteProjectPath(
  cwd: string,
  name: string,
  flavor: typeof posix,
): PathResult {
  if (!name) return unsafe("is empty");
  if (UNSAFE_CHARS.test(name) || (flavor === posix && name.includes("\\")))
    return unsafe("has a control character or backslash");
  const written =
    flavor === win32 ? withoutNamespace(name).replaceAll("/", "\\") : name;
  const { root } = flavor.parse(written);
  const parts = written.slice(root.length).split(flavor.sep);
  if (parts.includes("..")) return unsafe("uses .. ; name the file directly");
  if (
    flavor === win32 &&
    ((root !== "" && !win32.isAbsolute(written)) ||
      /^[\\]{2}[?.][\\]/.test(written) ||
      parts.some((part) => part !== "." && unsafeWindowsPart(part)))
  )
    return unsafe("uses an ambiguous Windows path");
  return {
    ok: true,
    path: flavor.resolve(
      flavor === win32 ? withoutNamespace(cwd) : cwd,
      written,
    ),
  };
}

/**
 * A project-relative POSIX path for what a tool names: absolute, or
 * relative to `cwd`. `..` anywhere is refused, never resolved: through a
 * symlinked folder it means something else on disk than on paper. A path
 * outside the project is `outside`, which no contract governs. `projectRoot`
 * may list several spellings of the same folder (as given, and resolved),
 * so a tool naming the folder another way can't step outside the check.
 */
export function projectPath(
  projectRoot: string | string[],
  cwd: string,
  name: string,
  flavor?: typeof posix,
): PathResult {
  const roots = [projectRoot].flat();
  flavor ??= projectFlavor(roots[0] ?? cwd);
  const absolute = absoluteProjectPath(cwd, name, flavor);
  if (!absolute.ok) return absolute;
  const relative = roots
    .map((root) => relativePath(root, absolute.path, flavor))
    .find(Boolean);
  if (!relative)
    return { ok: false, code: "outside", message: "is outside the project" };
  const parts = relative.split(flavor.sep);
  if (
    relative.length > FILE_LIMITS.pathLength ||
    parts.length > FILE_LIMITS.pathDepth
  )
    return unsafe("is too long");
  return { ok: true, path: parts.join("/") };
}

/** How paths compare: case and Unicode form never tell two files apart. */
export const pathKey = (path: string) => path.normalize("NFC").toLowerCase();

const escape = (text: string) => text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

function patternExpression(pattern: string) {
  return new RegExp(`^${escape(pathKey(pattern)).replace(/\*/g, "[^/]*")}$`);
}

/** Whether a contract governs a project-relative path. */
export function governs(contract: FileContract, path: string) {
  const key = pathKey(path);
  const root = pathKey(contract.root);
  if (root && !key.startsWith(`${root}/`)) return false;
  const rest = root ? key.slice(root.length + 1) : key;
  return patternExpression(contract.pattern).test(rest);
}

/** Every contract that governs the path: each one must hold. */
export const contractsFor = (contracts: FileContract[], path: string) =>
  contracts.filter((contract) => governs(contract, path));
