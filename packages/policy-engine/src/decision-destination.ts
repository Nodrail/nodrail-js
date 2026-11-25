import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { controlPlaneUrl } from "./connect-schema.ts";
import { secretRef } from "./connections.ts";
import { secretValue } from "./secret-refs.ts";
import { spoolFolder } from "./telemetry.ts";

export const reportFile = z.object({
  url: controlPlaneUrl,
  credential: secretRef,
  workspace: z.string().optional(),
  environment: z.string().optional(),
});

type ReportFile = z.infer<typeof reportFile>;
export type DecisionTarget = { url: string; credential: string };
export type VerifiedReport = { config: ReportFile; token?: string };

export function decisionDestination(
  file: string,
  env: Record<string, string | undefined>,
  verified?: VerifiedReport,
  timeout?: number,
) {
  const config =
    verified?.config ??
    reportFile.parse(JSON.parse(readFileSync(file, "utf8")));
  const url = config.url.replace(/\/+$/, "");
  const credential =
    verified?.token ?? secretValue(config.credential, env, timeout);
  // Credentials can be replaced in the host environment without editing the
  // file. Isolate that change too, including the outcome-to-action ID index.
  const binding = createHash("sha256")
    .update(
      JSON.stringify([url, config.workspace, config.environment, credential]),
    )
    .digest("hex");
  return { url, credential, binding };
}

export const decisionFolder = (home: string, file: string, binding: string) =>
  join(spoolFolder(home, file, "decisions"), binding);
