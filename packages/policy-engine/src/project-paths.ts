/**
 * `ref` read from the file at `from`, as a `/`-separated path from the same
 * root, or null when it climbs out of that root. No Node APIs, so it works the
 * same in a browser and on every system.
 */
export function joinPath(from: string, ref: string): string | null {
  if (ref.startsWith("/") || ref.includes("\\")) return null;
  const parts = from.split("/").slice(0, -1);
  for (const part of ref.split("/")) {
    if (part === "" || part === ".") continue;
    if (part !== "..") parts.push(part);
    else if (parts.length === 0) return null;
    else parts.pop();
  }
  return parts.length === 0 ? null : parts.join("/");
}
