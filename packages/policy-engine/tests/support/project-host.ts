import type { ProjectHost } from "../../src/yaml";

/**
 * A project folder in memory. `links` maps a path to where it really is,
 * undefined for a link out of the folder; a folder lists its own .yaml files.
 */
export function memoryHost(
  files: Record<string, string>,
  links: Record<string, string | undefined> = {},
): ProjectHost {
  return {
    read: (path) => files[path],
    real: (path) => (path in links ? links[path] : path),
    list: (path) => {
      // A folder exists when something is in it, as on a disk.
      const under = Object.keys(files).filter((file) =>
        file.startsWith(`${path}/`),
      );
      if (under.length === 0) return undefined;
      return under
        .filter(
          (file) =>
            !file.slice(path.length + 1).includes("/") && /\.ya?ml$/.test(file),
        )
        .sort();
    },
  };
}
