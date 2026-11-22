// Verifier resolution for plan (DC-03.1): an evidence requirement a verifier
// produces names it, and Cloud is where verifiers live. A missing or revoked
// verifier fails activation for every requirement that depends on it; with
// no token for Cloud here, plan says it couldn't check, and Cloud checks
// again when the workspace is published.
import type { Verifier } from "../api.ts";
import type { Command } from "../context.ts";
import { resolveToken } from "../config.ts";
import type { Check, SetupPlan } from "./plan.ts";

const name = (verifier: string) => `Verifier ${verifier}`;

const unchecked = (wanted: string[], detail: string): Check[] =>
  wanted.map((verifier) => ({
    name: name(verifier),
    ok: true,
    unverified: true,
    detail: `not checked: ${detail}. Cloud checks it again when the workspace is published`,
  }));

/** One check per verifier the plan's evidence requirements name. */
export async function verifierChecks(
  command: Pick<Command, "io" | "url" | "api">,
  plan: Pick<SetupPlan, "accountable">,
): Promise<Check[]> {
  const wanted = [
    ...new Set(plan.accountable.evidence.flatMap((line) => line.verifiers)),
  ].sort();
  if (wanted.length === 0) return [];
  const token = await resolveToken(
    command.io.env,
    command.io.home,
    command.url,
  );
  if (!token) return unchecked(wanted, `no token for ${command.url} here`);
  let verifiers: Verifier[];
  try {
    verifiers = (await (await command.api()).verifiers()).items;
  } catch (error) {
    return unchecked(
      wanted,
      `Cloud couldn't list verifiers (${(error as Error).message})`,
    );
  }
  return wanted.map((verifier) => {
    const rows = verifiers.filter((row) => row.name === verifier);
    const active = rows.find((row) => row.revokedAt === null);
    if (active)
      return {
        name: name(verifier),
        ok: true,
        detail: `${active.kind} for ${active.repository}, ${active.jobWorkflowRef}`,
      };
    const revoked = rows.find((row) => row.revokedAt !== null);
    return {
      name: name(verifier),
      ok: false,
      detail: revoked
        ? `verifier-missing: revoked on ${revoked.revokedAt!.slice(0, 10)}, so its evidence no longer counts. An admin creates a new one under Settings → Verifiers`
        : "verifier-missing: Cloud has no verifier by this name. An admin creates it under Settings → Verifiers",
    };
  });
}
