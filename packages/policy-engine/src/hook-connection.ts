// Connection settings are trustworthy only when they match the locked
// manifest. The generated JSON is a projection, never a credential authority.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { connectField, DEFAULT_CONTROL_PLANE_URL } from "./connect-schema.ts";
import { secretRef } from "./connections.ts";

const digest = z.string().regex(/^[0-9a-f]{64}$/);
const locked = z.object({ sha256: digest });
const repoLock = z.object({
  manifest: locked,
  effective: locked,
  workspace: locked,
});
const mode = z.enum(["on", "watch"]);
const local = z.object({ decide: z.literal("local"), enforce: mode });
const destination = z.object({
  enforce: mode,
  url: z.string(),
  credential: secretRef,
  workspace: z.string(),
  environment: z.string(),
});
const cloud = destination.extend({
  decide: z.literal("cloud"),
  lock: z.string().min(1),
  workspace_revision: digest,
  policy_digest: digest,
});
export type HookConnection = z.infer<typeof local | typeof cloud>;

function cloudSettings(
  config: unknown,
  expected: z.infer<typeof connectField>,
  repository: {
    lock: z.infer<typeof repoLock>;
    lockPath: string;
    folder: string;
  },
  legacy: boolean,
) {
  const { lock, lockPath, folder } = repository;
  const current = cloud.safeParse(config);
  const settings = current.success
    ? current.data
    : cloud.parse({
        ...destination.strict().parse(legacy ? config : null),
        decide: "cloud",
        lock: "../nodrail.lock.yaml",
        workspace_revision: lock.workspace.sha256,
        policy_digest: lock.effective.sha256,
      });
  const url = (expected.url ?? DEFAULT_CONTROL_PLANE_URL).replace(/\/+$/, "");
  if (
    settings.url !== url ||
    settings.workspace !== expected.workspace ||
    settings.environment !== expected.environment ||
    JSON.stringify(settings.credential) !==
      JSON.stringify(expected.credential) ||
    resolve(folder, settings.lock) !== lockPath ||
    settings.workspace_revision !== lock.workspace.sha256 ||
    settings.policy_digest !== lock.effective.sha256
  )
    throw new Error("the applied connection differs from the repository lock");
  return settings;
}

export function readHookConnection(
  file: string,
  legacy = false,
): HookConnection {
  const folder = dirname(resolve(file));
  const lockPath = resolve(folder, "../nodrail.lock.yaml");
  const lock = repoLock.parse(parse(readFileSync(lockPath, "utf8")));
  const manifest = readFileSync(resolve(folder, "../nodrail.yaml"), "utf8");
  if (
    createHash("sha256").update(manifest).digest("hex") !== lock.manifest.sha256
  )
    throw new Error("the manifest differs from the repository lock");
  const expected = connectField.parse(parse(manifest)?.connect);
  const config: unknown = JSON.parse(readFileSync(file, "utf8"));
  const settings =
    expected.decide === "cloud"
      ? cloudSettings(config, expected, { lock, lockPath, folder }, legacy)
      : local.parse(config);
  if (settings.enforce !== expected.enforce)
    throw new Error("the enforcement mode differs from the repository lock");
  return settings;
}
