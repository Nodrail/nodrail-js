// What `nodrail evidence run`, `show` and `submit` share: their flags, and
// the evidence's pinned contract in the policy.
import type { EvidenceContract, PolicyDocument } from "@nodrail/policy-engine";
import { CliError } from "../io.ts";
import { parseFlags } from "./subcommands.ts";

const options = {
  policy: { type: "string" },
  result: { type: "string" },
  key: { type: "string" },
  workspace: { type: "string" },
  environment: { type: "string", short: "e" },
  url: { type: "string" },
  json: { type: "boolean" },
} as const;

export const parseEvidenceArgs = (args: string[]) => parseFlags(args, options);

/** The evidence's pinned contract in the policy, or why it can't be produced so. */
export function contractOf(
  document: PolicyDocument,
  name: string,
  producer: "runtime-observed" | "externally-verified",
): EvidenceContract {
  const contract = document.version === 4 ? document.evidence[name] : undefined;
  if (!contract) {
    const known = document.version === 4 ? Object.keys(document.evidence) : [];
    throw new CliError(
      `No gate reads evidence named ${name}.${known.length ? ` Known: ${known.join(", ")}.` : " Declare it under contracts.evidence and require it in a gate (engine level 5)."}`,
    );
  }
  if (!contract.producers.some((p) => p.class === producer))
    throw new CliError(
      `${name} isn't produced as ${producer}: its producers are ${contract.producers.map((p) => p.class).join(", ")}.`,
    );
  return contract;
}

/** A digest's first 12 hex characters, or "unknown". */
export const short = (digest: string | null | undefined) =>
  digest ? digest.replace(/^sha256:/, "").slice(0, 12) : "unknown";
