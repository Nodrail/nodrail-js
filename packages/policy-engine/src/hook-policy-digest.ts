import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse } from "yaml";

/** Find the project lock above the cached policy file and compare its digest. */
export function policyDigestWarning(path: string, digest: string) {
  let directory = dirname(resolve(path));
  for (;;) {
    try {
      const lock = parse(
        readFileSync(join(directory, "nodrail.lock.yaml"), "utf8"),
      ) as {
        effective?: { sha256?: unknown };
      } | null;
      const expected = lock?.effective?.sha256;
      return typeof expected === "string" && expected !== digest
        ? `Nodrail: cached policy digest ${digest} differs from nodrail.lock.yaml (${expected}).\n`
        : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
    }
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}
