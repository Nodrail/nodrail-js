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
      const inside = Object.keys(files).filter(
        (file) =>
          file.startsWith(`${path}/`) &&
          !file.slice(path.length + 1).includes("/") &&
          /\.ya?ml$/.test(file),
      );
      return inside.length > 0 ? inside.sort() : undefined;
    },
  };
}
