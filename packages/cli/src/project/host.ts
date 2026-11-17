import { readFileSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { ProjectHost } from "@nodrail/policy-engine/yaml";

const missing = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === "ENOENT";

/**
 * The project folder for the resolver. Paths are `/`-separated from the
 * folder; a link that leads outside it reads as leaving the folder, so no
 * import can reach a file the project doesn't hold.
 */
export function folderHost(root: string): ProjectHost {
  const base = realpathSync(root);
  return {
    read(path) {
      try {
        return readFileSync(join(base, path), "utf8");
      } catch (error) {
        if (missing(error)) return undefined;
        throw error;
      }
    },
    real(path) {
      const inside = relative(base, realPath(join(base, path)));
      if (
        inside === "" ||
        inside.startsWith("..") ||
        inside.includes(`:${sep}`)
      )
        return undefined;
      return inside.split(sep).join("/");
    },
  };
}

/**
 * The path with links followed. For a file that isn't there, its nearest
 * folder that is, so a missing file under a link out still counts as out.
 */
function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    if (!missing(error)) throw error;
    const parent = join(path, "..");
    if (parent === path) throw error;
    return join(realPath(parent), relative(parent, path));
  }
}
