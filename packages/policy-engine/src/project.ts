import { parse } from "yaml";
import { bindFile, bindingsUsed, renameAgents } from "./project-bind.ts";
import {
  bindingProblem,
  importOf,
  MODULE_KIND,
  moduleManifest,
  PROJECT_KIND,
  projectManifest,
  setupFields,
  invalidField,
  standIns,
  type ModuleManifest,
  type ProjectImport,
  type ProjectManifest,
} from "./project-manifest.ts";
import {
  emptySetup,
  unplayedRoles,
  type ProjectSetup,
  type SetupBinding,
} from "./project-resources.ts";
import { dataProblems, membersOf, readSetup } from "./project-setup.ts";
import { teamRules } from "./project-team.ts";
import {
  catalogEntry,
  parseModuleRef,
  type Catalog,
  type CatalogModule,
} from "./catalog.ts";
import { joinPath } from "./project-paths.ts";
import type { PolicySource } from "./rules-file.ts";

/** The project's files, by `/`-separated path from the project's folder. */
export type ProjectHost = {
  /** The file's exact text, or undefined when there is none. */
  read(path: string): string | undefined;
  /** Its real path with links followed, or undefined if that leaves the folder. */
  real(path: string): string | undefined;
  /**
   * The .yaml and .yml files directly in a folder, as project paths, sorted;
   * undefined when the path isn't a folder. Without it, resources are files.
   */
  list?(path: string): string[] | undefined;
};

/** One file the policy was built from, with its exact text. */
export type ProjectInput =
  | { kind: "local"; path: string; text: string }
  | {
      kind: "catalog";
      id: string;
      version: string;
      path: string;
      text: string;
    };

/** A catalog module the project uses, with its values and what it lacks. */
export type ModuleUse = {
  id: string;
  version: string;
  bindings: Record<string, string>;
  /** Parameters without a value: the module is saved but not yet in effect. */
  missing: string[];
  manifest: ModuleManifest;
};

export type ProjectProblem = { ref: string; from: string; message: string };

export type ProjectResolution = {
  /** The policy's files in effect order, bound, ready for compilePolicies. */
  sources: PolicySource[];
  /**
   * The same with every module, a missing value filled with a stand-in: what
   * the project will be once configured, to check that it compiles already.
   */
  checking: PolicySource[];
  inputs: ProjectInput[];
  edges: { from: string; to: string }[];
  modules: ModuleUse[];
  problems: ProjectProblem[];
  /** The agents, team and bindings nodrail.yaml's resources declare. */
  setup: ProjectSetup;
};

type Options = {
  host: ProjectHost;
  catalog: Catalog;
  /** The project manifest's path. */
  manifest?: string;
  /** Versions the lock holds, by module id. */
  pins?: Readonly<Record<string, string>>;
};

/** A catalog module being read, and how the project uses it. */
type Owner = { module: CatalogModule; use: ModuleUse };

const isApf = (value: unknown) => value === null || Array.isArray(value);
const kindOf = (value: unknown) =>
  value !== null && typeof value === "object" && "kind" in value
    ? value.kind
    : undefined;

class Resolver {
  readonly result: ProjectResolution = {
    sources: [],
    checking: [],
    inputs: [],
    edges: [],
    modules: [],
    problems: [],
    setup: emptySetup(),
  };
  private readonly seen = new Set<string>();
  private readonly visiting: string[] = [];
  /** Each bound policy's binding, by module id or Policy name. */
  private readonly bindings = new Map<string, SetupBinding>();
  /** The agent names each bound policy's files use, by module id or name. */
  private readonly used = new Map<string, Set<string>>();

  private readonly options: Options;

  constructor(options: Options) {
    this.options = options;
  }

  problem(ref: string, from: string, message: string) {
    this.result.problems.push({ ref, from, message });
  }

  /** Enters a file once; false when it was done already or is a cycle. */
  enter(key: string, ref: string, from: string) {
    if (this.visiting.includes(key)) {
      const chain = [...this.visiting.slice(this.visiting.indexOf(key)), key];
      this.problem(ref, from, `Import cycle: ${chain.join(" → ")}`);
      return false;
    }
    if (this.seen.has(key)) return false;
    this.visiting.push(key);
    return true;
  }

  leave(key: string) {
    this.visiting.pop();
    this.seen.add(key);
  }

  parsed(text: string, ref: string, from: string): unknown {
    try {
      return parse(text) as unknown;
    } catch (error) {
      this.problem(ref, from, `Not YAML: ${(error as Error).message}`);
      return undefined;
    }
  }

  /** A local file: a rules file, or a manifest whose imports come first. */
  local(path: string, ref: string, from: string) {
    const real = this.options.host.real(path);
    if (real === undefined)
      return this.problem(ref, from, "The path leaves the project folder");
    if (!this.enter(real, ref, from)) return;
    const text = this.options.host.read(real);
    if (text === undefined) this.problem(ref, from, "No such file");
    else this.localText(real, text, ref, from);
    this.leave(real);
  }

  private localText(path: string, text: string, ref: string, from: string) {
    this.result.inputs.push({ kind: "local", path, text });
    const value = this.parsed(text, ref, from);
    if (value === undefined) return;
    if (isApf(value)) {
      this.result.sources.push({ name: path, text });
      this.result.checking.push({ name: path, text });
      return;
    }
    if (kindOf(value) !== PROJECT_KIND)
      return this.problem(
        ref,
        from,
        `Expected rules or a ${PROJECT_KIND} manifest`,
      );
    const manifest = projectManifest.safeParse(value);
    if (!manifest.success)
      return this.problem(ref, from, invalidField(manifest.error.issues));
    const root = from === "";
    const setup = Object.keys(setupFields).filter(
      (field) => field in manifest.data,
    );
    if (!root && setup.length > 0)
      this.problem(ref, from, `Only nodrail.yaml says ${setup.join(", ")}`);
    if (root) this.readSetup(manifest.data, path);
    this.imports(manifest.data.imports.map(importOf), path);
    if (root) this.boundPolicies();
  }

  /** Reads the resources before any import, so bound ones are renamed. */
  private readSetup(manifest: ProjectManifest, path: string) {
    const { result, options } = this;
    const bindings = readSetup(
      {
        host: options.host,
        catalog: options.catalog,
        setup: result.setup,
        inputs: result.inputs,
        problem: (ref, from, message) => this.problem(ref, from, message),
      },
      manifest,
      path,
    );
    for (const [target, binding] of bindings) {
      this.bindings.set(target, binding);
      this.used.set(target, new Set());
    }
  }

  /**
   * The rules of a bound policy, with its roles renamed to the team's agents.
   * The names it uses are checked once all of it is read.
   */
  private renamed(target: string, text: string, ref: string, from: string) {
    const binding = this.bindings.get(target);
    if (binding === undefined) return text;
    const renamed = renameAgents(text, binding.roles);
    for (const message of renamed.problems)
      this.problem(ref, from, `${message}; a PolicyBinding can't rename those`);
    for (const name of renamed.names) this.used.get(target)?.add(name);
    return renamed.text;
  }

  /** Policies bound by name, after the imports, in their bindings' order. */
  private boundPolicies() {
    const { setup } = this.result;
    for (const [target, binding] of this.bindings) {
      const policy = setup.policies.find((each) => each.name === target);
      if (policy) this.policySource(policy.source, target, policy.file);
      else if (!this.result.modules.some((use) => use.id === target))
        this.problem(
          binding.name,
          binding.file,
          `${target} isn't imported; add it to imports first`,
        );
      const used = this.used.get(target) ?? new Set<string>();
      for (const message of unplayedRoles(binding, used, membersOf(setup)))
        this.problem(binding.name, binding.file, message);
    }
    // Last, the started team's own rules: who may start whom, setup kept safe.
    if (setup.team === null) return;
    const name = `team/${setup.team.name}.apf.yaml`;
    const text = teamRules(setup.team, setup);
    this.result.sources.push({ name, text });
    this.result.checking.push({ name, text });
  }

  private policySource(path: string, name: string, from: string) {
    if (this.seen.has(path))
      return this.problem(
        path,
        from,
        "Already imported unbound; import it or bind it, not both",
      );
    if (!this.enter(path, path, from)) return;
    const text = this.options.host.read(path);
    const value =
      text === undefined ? undefined : this.parsed(text, path, from);
    if (text === undefined) this.problem(path, from, "No such file");
    else if (value !== undefined && !isApf(value))
      this.problem(path, from, "A Policy's source is a rules file");
    else if (value !== undefined) {
      this.result.inputs.push({ kind: "local", path, text });
      this.result.edges.push({ from, to: path });
      const bound = this.renamed(name, text, path, from);
      this.result.sources.push({ name: path, text: bound });
      this.result.checking.push({ name: path, text: bound });
    }
    this.leave(path);
  }

  imports(entries: ProjectImport[], from: string) {
    for (const entry of entries) {
      if (entry.ref.startsWith("@")) this.catalog(entry, from);
      else this.localImport(entry, from);
    }
  }

  private localImport(entry: ProjectImport, from: string) {
    const { ref } = entry;
    if (!/^\.\.?\//.test(ref) || !/\.ya?ml$/.test(ref))
      return this.problem(
        ref,
        from,
        "Local imports start with ./ and end in .yaml",
      );
    if (entry.with)
      return this.problem(ref, from, "Only catalog modules take values");
    const path = joinPath(from, ref);
    if (path === null)
      return this.problem(ref, from, "The path leaves the project folder");
    this.result.edges.push({ from, to: path });
    this.local(path, ref, from);
  }

  private catalog(entry: ProjectImport, from: string) {
    if (parseModuleRef(entry.ref).version !== undefined)
      return this.problem(
        entry.ref,
        from,
        "Versions live in nodrail.lock.yaml, not the manifest",
      );
    const found = catalogEntry(
      this.options.catalog,
      entry.ref,
      this.options.pins,
    );
    if ("problem" in found) return this.problem(entry.ref, from, found.problem);
    const { module } = found;
    const key = `${module.id}@${module.version}`;
    this.result.edges.push({ from, to: key });
    const use = this.use(module, entry, from);
    if (use === null || !this.enter(key, entry.ref, from)) return;
    this.result.modules.push(use);
    const owner = { module, use };
    for (const path of use.manifest.imports)
      this.moduleFile(owner, joinPath("module.yaml", path), key);
    this.leave(key);
  }

  /** The module's values checked, or null when they conflict or fail. */
  private use(module: CatalogModule, entry: ProjectImport, from: string) {
    const manifest = this.moduleManifest(module, entry.ref, from);
    if (manifest === null) return null;
    const bindings = entry.with ?? {};
    const earlier = this.result.modules.find((use) => use.id === module.id);
    if (earlier) {
      if (JSON.stringify(earlier.bindings) !== JSON.stringify(sorted(bindings)))
        this.problem(
          entry.ref,
          from,
          `${module.id} is imported with different values`,
        );
      return null;
    }
    return this.checked(module, manifest, bindings, { ref: entry.ref, from });
  }

  private moduleManifest(module: CatalogModule, ref: string, from: string) {
    const text = module.files["module.yaml"];
    const parsed = moduleManifest.safeParse(
      text === undefined ? undefined : this.parsed(text, ref, from),
    );
    if (parsed.success) return parsed.data;
    this.problem(ref, from, `${module.id}@${module.version} is damaged`);
    return null;
  }

  private checked(
    module: CatalogModule,
    manifest: ModuleManifest,
    bindings: Record<string, string>,
    { ref, from }: { ref: string; from: string },
  ): ModuleUse | null {
    const parameters = manifest.parameters ?? {};
    for (const name of Object.keys(bindings))
      if (!(name in parameters))
        return (
          this.problem(ref, from, `${module.id} has no parameter ${name}`),
          null
        );
    for (const [name, value] of Object.entries(bindings)) {
      const problem =
        value === "" ? null : bindingProblem(parameters[name]!.type, value);
      if (problem)
        return (this.problem(ref, from, `${name}: ${problem}`), null);
    }
    const missing = Object.keys(parameters)
      .filter((name) => !bindings[name])
      .sort();
    return {
      id: module.id,
      version: module.version,
      bindings: sorted(bindings),
      missing,
      manifest,
    };
  }

  private moduleFile(owner: Owner, path: string | null, from: string) {
    const { module } = owner;
    const label = path ?? "?";
    if (path === null)
      return this.problem(label, from, "The path leaves the module");
    const key = `${module.id}@${module.version}/${path}`;
    if (!this.enter(key, path, from)) return;
    this.result.edges.push({ from, to: key });
    const text = module.files[path];
    if (text === undefined)
      this.problem(path, from, `${module.id} has no file ${path}`);
    else this.moduleText(owner, { path, text }, key);
    this.leave(key);
  }

  private moduleText(
    owner: Owner,
    { path, text }: { path: string; text: string },
    key: string,
  ) {
    const { id, version } = owner.module;
    this.result.inputs.push({ kind: "catalog", id, version, path, text });
    const value = this.parsed(text, path, key);
    if (value === undefined) return;
    if (kindOf(value) === MODULE_KIND) {
      const nested = moduleManifest.safeParse(value);
      if (!nested.success)
        return this.problem(path, key, "The manifest's fields are not valid");
      for (const child of nested.data.imports)
        this.moduleFile(owner, joinPath(path, child), key);
      return;
    }
    if (!isApf(value))
      return this.problem(path, key, "Expected rules or a module manifest");
    this.bound(owner.use, { path, text }, key);
  }

  private bound(
    use: ModuleUse,
    { path, text }: { path: string; text: string },
    key: string,
  ) {
    const declared = use.manifest.parameters ?? {};
    const unknown = bindingsUsed(text).find((name) => !(name in declared));
    if (unknown)
      return this.problem(path, key, `Uses undeclared value ${unknown}`);
    text = this.renamed(use.id, text, path, key);
    const name = `${use.id}/${path}`;
    const standIn = Object.fromEntries(
      Object.entries(declared).map(([key, { type }]) => [key, standIns[type]]),
    );
    this.result.checking.push({
      name,
      text: bindFile(text, { ...standIn, ...use.bindings }),
    });
    if (use.missing.length > 0) return;
    this.result.sources.push({ name, text: bindFile(text, use.bindings) });
  }
}

function sorted(values: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(values)
      .filter(([, value]) => value !== "")
      .sort(([a], [b]) => (a < b ? -1 : 1)),
  );
}

/**
 * Everything a project's manifest brings in, in effect order: its imports
 * first to last, each nested import before what imports it continues, and a
 * file shared by two imports once, where it is first reached. Reads nothing
 * outside the project folder and the catalog given; never the network.
 */
export function resolveProject(options: Options): ProjectResolution {
  const resolver = new Resolver(options);
  const manifest = options.manifest ?? "nodrail.yaml";
  resolver.local(manifest, manifest, "");
  // Once everything is read: what the lock covers is known.
  dataProblems(resolver.result, manifest);
  return resolver.result;
}
