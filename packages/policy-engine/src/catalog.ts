/** A packaged module at one exact version: its files, by path, byte for byte. */
export type CatalogModule = {
  id: string;
  version: string;
  /** Other names that mean this module, such as a file-like spelling. */
  aliases?: readonly string[];
  files: Readonly<Record<string, string>>;
};

/** The modules a command line ships with. v1 reads nothing else. */
export type Catalog = readonly CatalogModule[];

/** Publishers whose modules a catalog can hold. */
const PUBLISHERS = ["@nodrail/"];

const versionPattern = /^\d+\.\d+\.\d+$/;

/** Newest first. */
function byVersion(a: CatalogModule, b: CatalogModule) {
  const left = a.version.split(".").map(Number);
  const right = b.version.split(".").map(Number);
  for (let index = 0; index < 3; index += 1)
    if (left[index] !== right[index]) return right[index]! - left[index]!;
  return 0;
}

/** A reference split into its name and the exact version asked for, if any. */
export function parseModuleRef(ref: string) {
  const at = ref.lastIndexOf("@");
  if (at > 0) return { name: ref.slice(0, at), version: ref.slice(at + 1) };
  return { name: ref, version: undefined };
}

/** The module's own id for a name or alias, or undefined. */
export function canonicalId(catalog: Catalog, name: string) {
  return catalog.find(
    (module) => module.id === name || module.aliases?.includes(name),
  )?.id;
}

/**
 * The catalog module a reference means: the version asked for, else the one
 * the lock holds, else the newest the catalog has. Never a version the
 * catalog lacks: asking for one is an error, not a download.
 */
export function catalogEntry(
  catalog: Catalog,
  ref: string,
  pins: Readonly<Record<string, string>> = {},
): { module: CatalogModule } | { problem: string } {
  const { name, version } = parseModuleRef(ref);
  if (!PUBLISHERS.some((publisher) => name.startsWith(publisher)))
    return {
      problem: `Unknown publisher: only ${PUBLISHERS.join(", ")} modules are available`,
    };
  const id = canonicalId(catalog, name);
  if (id === undefined) return { problem: `No module named ${name}` };
  if (version !== undefined && !versionPattern.test(version))
    return { problem: `Expected an exact version, like ${id}@1.0.0` };
  const wanted = version ?? pins[id];
  const versions = catalog.filter((module) => module.id === id).sort(byVersion);
  const module = wanted
    ? versions.find((entry) => entry.version === wanted)
    : versions[0];
  if (!module)
    return {
      problem: `${id}@${wanted} is not in this catalog (it has ${versions.map((entry) => entry.version).join(", ")})`,
    };
  return { module };
}
