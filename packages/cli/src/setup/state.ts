import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { CliError } from "../io.ts";

/**
 * What `nodrail apply` last wrote, for each host it set up: each file that
 * host owns with the hash it wrote, and the settings it set. Only these does
 * nodrail ever change or remove; a file edited since then is the person's,
 * until they say otherwise. One project can be set up for both hosts: each
 * keeps its own entry, and a file both need is owned by both.
 */
export const STATE_FILE = ".nodrail/setup-state.json";

export type Runtime = "claude-code" | "codex" | "copilot";

/** Each host as people call it. */
export const HOST_NAMES: Record<Runtime, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  copilot: "Copilot",
};
const runtime = z.enum(["claude-code", "codex", "copilot"]);

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const hostShape = z
  .object({
    files: z.record(z.string(), sha256),
    settings: z
      .object({
        agent: z.string().optional(),
        /** Claude Code: the `.mcp.json` servers nodrail added. */
        mcpServers: z.array(z.string()).optional(),
        /** Claude Code: the marketplaces and plugins nodrail switched on. */
        marketplaces: z.array(z.string()).optional(),
        plugins: z.array(z.string()).optional(),
      })
      .strict(),
    /**
     * Each connection's data, as nodrail.yaml declared it: nodrail never
     * removes it, and says where it stays once the connection is gone.
     */
    data: z.record(z.string(), z.array(z.string())).optional(),
    /** The reviewed revision this host was last applied from. */
    revision: z
      .object({ policy: sha256.optional(), workspace: sha256.optional() })
      .strict()
      .optional(),
  })
  .strict();
export type HostState = z.infer<typeof hostShape>;

const stateShape = z
  .object({
    state: z.literal(2),
    hosts: z.partialRecord(runtime, hostShape),
  })
  .strict();
export type SetupState = z.infer<typeof stateShape>;

/** The first state held one host, the last one applied. */
const firstShape = hostShape.extend({ state: z.literal(1), runtime }).strict();

const parse = (value: unknown): SetupState | null => {
  const now = stateShape.safeParse(value);
  if (now.success) return now.data;
  const first = firstShape.safeParse(value);
  if (!first.success) return null;
  const { files, settings } = first.data;
  return { state: 2, hosts: { [first.data.runtime]: { files, settings } } };
};

export function readState(root: string): SetupState | null {
  let text: string;
  try {
    text = readFileSync(join(root, STATE_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    value = undefined;
  }
  const state = parse(value);
  if (state === null)
    throw new CliError(
      `${STATE_FILE} is damaged. Restore it from git, or remove it to treat every file as not written by nodrail.`,
    );
  return state;
}

/** What this host set up before, if it did. */
export const hostState = (
  state: SetupState | null,
  host: Runtime,
): HostState | null => state?.hosts[host] ?? null;

/** The hosts other than this one that own `path`, with the hash each wrote. */
export function otherOwners(
  state: SetupState | null,
  host: Runtime,
  path: string,
) {
  return Object.entries(state?.hosts ?? {}).flatMap(([name, entry]) =>
    name !== host && entry?.files[path] !== undefined
      ? [{ host: name as Runtime, hash: entry.files[path]! }]
      : [],
  );
}
