import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { CliError } from "../io.ts";

/**
 * What `nodrail apply` last wrote: each file it owns with the hash it wrote,
 * and the settings it set. Only these does nodrail ever change or remove; a
 * file edited since then is the person's, until they say otherwise.
 */
export const STATE_FILE = ".nodrail/setup-state.json";

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const stateShape = z
  .object({
    state: z.literal(1),
    runtime: z.enum(["claude-code", "codex"]),
    files: z.record(z.string(), sha256),
    settings: z.object({ agent: z.string().optional() }).strict(),
  })
  .strict();
export type SetupState = z.infer<typeof stateShape>;

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
  const parsed = stateShape.safeParse(value);
  if (!parsed.success)
    throw new CliError(
      `${STATE_FILE} is damaged. Restore it from git, or remove it to treat every file as not written by nodrail.`,
    );
  return parsed.data;
}
