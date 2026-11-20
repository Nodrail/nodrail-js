import type { Runtime, Tested } from "@nodrail/policy-engine/yaml";
import { VERSION } from "../version.ts";

/** What runs here, as `tested` names it. */
export type Running = { nodrail: string; node: string } & Partial<
  Record<Runtime, string>
>;

/** What runs here now: this nodrail, its Node and the chosen host. */
export const runningHere = (
  runtime: Runtime,
  host: string | null,
): Running => ({
  nodrail: VERSION,
  node: process.versions.node,
  ...(host === null ? {} : { [runtime]: host }),
});

/**
 * How what runs here compares with the versions the workspace was tested
 * with. Another version isn't refused: it is unverified, and said so, for
 * the person to choose. Null when nodrail.yaml names no profile.
 */
export function testedCheck(
  tested: Tested | null,
  runtime: Runtime,
  running: Running,
) {
  if (tested === null) return null;
  const names = ["nodrail", "node", runtime] as const;
  const listed = names.filter((name) => tested[name] !== undefined);
  const differs = listed.flatMap((name) =>
    running[name] === tested[name]
      ? []
      : [`${name} ${running[name] ?? "not found"} (tested ${tested[name]})`],
  );
  const untested = names.filter((name) => tested[name] === undefined);
  const same = listed.map((name) => `${name} ${tested[name]}`).join(", ");
  if (differs.length === 0 && untested.length === 0)
    return { name: "tested", ok: true, detail: `runs as tested: ${same}` };
  return {
    name: "tested",
    ok: true,
    unverified: true,
    detail: [
      ...(differs.length > 0 ? [`unverified here: ${differs.join(", ")}`] : []),
      ...(untested.length > 0
        ? [`no tested version for ${untested.join(", ")}`]
        : []),
    ].join("; "),
  };
}
