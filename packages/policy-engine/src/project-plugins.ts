import type { ProjectHost } from "./project.ts";
import type { ProjectSetup, SetupPlugin } from "./project-resources.ts";
import type { PluginSpec } from "./plugins.ts";

type Host = "claude-code" | "codex";

/** Where each host reads a plugin's manifest, from the plugin's folder. */
const MANIFESTS: Record<Host, string> = {
  "claude-code": ".claude-plugin/plugin.json",
  codex: ".codex-plugin/plugin.json",
};

const json = (text: string | undefined): Record<string, unknown> | null => {
  if (text === undefined) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

/**
 * The MCP servers a host's manifest brings: `mcpServers` inline or as a
 * file in the plugin; for Claude Code, `.mcp.json` when it says neither.
 */
function serversIn(
  read: ProjectHost["read"],
  folder: string,
  host: Host,
  manifest: Record<string, unknown>,
) {
  const field = manifest.mcpServers;
  const file =
    typeof field === "string"
      ? `${folder}/${field.replace(/^\.\//, "")}`
      : field === undefined && host === "claude-code"
        ? `${folder}/.mcp.json`
        : null;
  const inline =
    field !== null && typeof field === "object"
      ? (field as Record<string, unknown>)
      : null;
  const servers =
    inline ??
    (json(file ? read(file) : undefined)?.mcpServers as
      Record<string, unknown> | undefined);
  return new Set(Object.keys(servers ?? {}));
}

/**
 * Reads one plugin: its folder in the project, a manifest for each host the
 * setup is for, named as declared, and each declared server in each of them.
 * Returns the plugin and what's wrong with it.
 */
export function readPlugin(input: {
  name: string;
  spec: PluginSpec;
  /** The folder as a project path, or undefined when it leaves the project. */
  folder: string | undefined;
  host: ProjectHost;
  runtimes: ProjectSetup["runtimes"];
  written: (path: string) => boolean;
}): { plugin: SetupPlugin | null; problems: string[] } {
  const { name, spec, folder, host } = input;
  if (folder === undefined)
    return { plugin: null, problems: ["The path leaves the project folder"] };
  if (input.written(folder))
    return {
      plugin: null,
      problems: [
        "nodrail apply writes there, so it can't be a source; keep it in a folder of your own",
      ],
    };
  if (host.list?.(folder) === undefined)
    return {
      plugin: null,
      problems: [
        spec.from
          ? `No such folder: run \`nodrail plugin fetch ${name}\` to copy it from ${spec.from.git}`
          : "No such folder",
      ],
    };
  const problems: string[] = [];
  const hosts: Host[] = [];
  const versions: SetupPlugin["versions"] = {};
  for (const runtime of Object.keys(MANIFESTS) as Host[]) {
    const manifest = json(host.read(`${folder}/${MANIFESTS[runtime]}`));
    if (manifest === null) {
      if (input.runtimes.includes(runtime))
        problems.push(
          `No ${MANIFESTS[runtime]} in ${folder}, and the setup is for ${runtime}`,
        );
      continue;
    }
    hosts.push(runtime);
    if (manifest.name !== name)
      problems.push(
        `${MANIFESTS[runtime]} names it ${String(manifest.name)}, not ${name}`,
      );
    // Each host reads its own manifest's version, which may differ.
    if (typeof manifest.version === "string")
      versions[runtime] = manifest.version;
    const servers = serversIn(
      (file) => host.read(file),
      folder,
      runtime,
      manifest,
    );
    for (const server of Object.keys(spec.servers))
      if (!servers.has(server))
        problems.push(`Its ${runtime} manifest brings no MCP server ${server}`);
  }
  return { plugin: { name, spec, folder, hosts, versions }, problems };
}
