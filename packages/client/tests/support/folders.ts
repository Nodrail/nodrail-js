import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";

/** A temporary folder, removed after the current test. */
export function scratchFolders() {
  const made: string[] = [];
  afterEach(() => {
    for (const folder of made.splice(0))
      rmSync(folder, { recursive: true, force: true });
  });
  return (prefix: string) => {
    const folder = mkdtempSync(join(tmpdir(), prefix));
    made.push(folder);
    return folder;
  };
}
