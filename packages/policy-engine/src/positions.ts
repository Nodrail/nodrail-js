// Where a problem in a rules file is: the key or value it is about, found in
// the YAML nodes, so an editor can underline the right thing.
import {
  isAlias,
  isMap,
  isScalar,
  isSeq,
  type Document,
  type LineCounter,
} from "yaml";

export type Place = { file: string; line: number; column: number };
export type Path = (string | number)[];
/** The key itself (an unknown key) or its value (a bad value). */
export type Part = "key" | "value";
/** The place of a path inside one entry, or null when it isn't there. */
export type Where = (path: Path, part?: Part) => Place | null;

type Ranged = { range?: [number, number, number] | null };
type Found = { key: unknown; value: unknown };

function step(doc: Document, node: unknown, key: string | number) {
  const parent = isAlias(node) ? node.resolve(doc) : node;
  if (isMap(parent)) {
    const pair = parent.items.find(
      (item) => (isScalar(item.key) ? item.key.value : item.key) === key,
    );
    return pair ? { key: pair.key, value: pair.value } : null;
  }
  if (isSeq(parent) && typeof key === "number" && key in parent.items)
    return { key: null, value: parent.items[key] };
  return null;
}

/** An empty value (`effect:`) has nowhere to point, so its key stands in. */
function offsetOf({ key, value }: Found, part: Part) {
  const range = (value as Ranged | null)?.range;
  const keyStart = (key as Ranged | null)?.range?.[0];
  if (part === "key" || !range || range[0] === range[1])
    return keyStart ?? range?.[0];
  return range[0];
}

/** Finds paths inside the entry at `index` of the file's list. */
export function entryWhere(
  doc: Document,
  counter: LineCounter,
  file: string,
  index: number,
): Where {
  return (path, part = "value") => {
    let found: Found | null = { key: null, value: doc.getIn([index], true) };
    for (const key of path) {
      found = step(doc, found.value, key);
      if (!found) return null;
    }
    const offset = offsetOf(found, part);
    if (offset === undefined) return null;
    const { line, col } = counter.linePos(offset);
    return { file, line, column: col };
  };
}

/** Where an entry's problem is: the first path that exists, else the entry. */
export function pick(
  entry: Place & { where?: Where },
  paths: Path[],
  part: Part = "value",
): Place {
  for (const path of paths) {
    const place = entry.where?.(path, part);
    if (place) return place;
  }
  return { file: entry.file, line: entry.line, column: entry.column };
}

/**
 * Where the fields of an entry changed by a later override are: a replaced
 * field, or an appended item, is where the later entry wrote it.
 */
export function layered(
  earlier: object & { where: Where },
  later: Where,
  override: Record<string, string>,
): Where {
  return (path, part) => {
    const [field, index, ...rest] = path;
    if (typeof field !== "string" || !(field in override))
      return earlier.where(path, part);
    const before: unknown = (earlier as Record<string, unknown>)[field];
    const kept =
      override[field] === "append" && Array.isArray(before) ? before.length : 0;
    if (typeof index !== "number" || index >= kept)
      return later(
        typeof index === "number" ? [field, index - kept, ...rest] : path,
        part,
      );
    return earlier.where(path, part);
  };
}

/** A path, then each path above it: a missing key points at its parent. */
export const upward = (path: Path): Path[] =>
  path.map((_, depth) => path.slice(0, path.length - depth));

/** Where a schema problem is: an unknown key at that key, else the value. */
export function issuePlace(
  entry: Place & { where?: Where },
  issue: { code: string; path: PropertyKey[]; keys?: string[] },
): Place {
  const path = issue.path.filter(
    (key): key is string | number => typeof key !== "symbol",
  );
  const unknown = issue.code === "unrecognized_keys" ? issue.keys?.[0] : null;
  const atKey = unknown ? entry.where?.([...path, unknown], "key") : null;
  return atKey ?? pick(entry, upward(path));
}
