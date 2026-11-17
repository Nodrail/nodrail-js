import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Catalog, CatalogModule } from "@nodrail/policy-engine/yaml";
import { parse } from "yaml";

/** The package's catalog folder, from the source tree or the built file. */
export function catalogFolder(from = fileURLToPath(import.meta.url)) {
  for (let folder = dirname(from); ; folder = dirname(folder)) {
    const candidate = join(folder, "catalog");
    if (existsSync(join(candidate, "aliases.yaml"))) return candidate;
    if (dirname(folder) === folder)
      throw new Error("This installation has no module catalog");
  }
}

function filesUnder(folder: string, root = folder): [string, string][] {
  return readdirSync(folder, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .flatMap((entry) => {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) return filesUnder(path, root);
      return [
        [relative(root, path).split(sep).join("/"), readFileSync(path, "utf8")],
      ];
    });
}

const folders = (path: string) =>
  readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

/**
 * The modules this command line ships with, byte for byte: the folder
 * catalog/<publisher>/<name>/<version>/ is the module @<publisher>/<name> at
 * that version. Nothing is fetched.
 */
export function bundledCatalog(folder = catalogFolder()): Catalog {
  const aliases = (parse(readFileSync(join(folder, "aliases.yaml"), "utf8")) ??
    {}) as Record<string, string>;
  const modules: CatalogModule[] = [];
  for (const publisher of folders(folder))
    for (const name of folders(join(folder, publisher)))
      for (const version of folders(join(folder, publisher, name))) {
        const id = `@${publisher}/${name}`;
        modules.push({
          id,
          version,
          aliases: Object.keys(aliases).filter(
            (alias) => aliases[alias] === id,
          ),
          files: Object.fromEntries(
            filesUnder(join(folder, publisher, name, version)),
          ),
        });
      }
  return modules;
}
