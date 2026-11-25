import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const POLICY_CHECK_FILE = "last-check.json";

/** One observation per checkout. No credential, arguments or policy body. */
export async function recordPolicyCheck(
  folder: string,
  settings: { workspace_revision: string; policy_digest: string },
  state: "live" | "cached" | "unavailable",
  detail?: string,
) {
  const file = join(folder, POLICY_CHECK_FILE);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await mkdir(folder, { recursive: true, mode: 0o700 });
    await writeFile(
      temporary,
      JSON.stringify({
        at: new Date().toISOString(),
        revision: settings.workspace_revision,
        digest: settings.policy_digest,
        state,
        detail,
      }),
      { mode: 0o600, flag: "wx" },
    );
    await rename(temporary, file);
  } catch {
    await rm(temporary, { force: true }).catch(() => {});
  }
}
