import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { ProjectHost } from "@nodrail/policy-engine/yaml";

const missing = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === "ENOENT";
/** Not a file to read: nothing there, or a folder. */
const notAFile = (error: unknown) =>
  missing(error) || (error as NodeJS.ErrnoException).code === "EISDIR";

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
        if (notAFile(error)) return undefined;
        throw error;
      }
    },
    list(path) {
      let entries;
      try {
        entries = readdirSync(join(base, path), { withFileTypes: true });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") return undefined;
        throw error;
      }
      // Links are listed too; reading one goes through real(), which refuses
      // any that lead out of the folder.
      return entries
        .filter(
          (entry) =>
            (entry.isFile() || entry.isSymbolicLink()) &&
            /\.ya?ml$/.test(entry.name),
        )
        .map((entry) => `${path}/${entry.name}`)
        .sort();
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
