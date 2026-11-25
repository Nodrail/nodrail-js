import { z } from "zod";
import { secretRef } from "./connections.ts";

/**
 * `connect:` in nodrail.yaml: the Nodrail (Cloud or self-hosted) this
 * project is connected to, and where the host gets its policy. Without it,
 * nothing changes: the local engine decides and nothing is sent.
 */

export const DEFAULT_CONTROL_PLANE_URL = "https://app.nodrail.com";

const slug = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9-]{0,62}$/,
    "A slug, as in the address /app/<workspace>/<environment>",
  );

/** Nodrail's address: https, or http to localhost only. */
export const controlPlaneUrl = z
  .url({ protocol: /^https?$/ })
  .max(2000)
  .refine(
    (url) =>
      url.startsWith("https://") ||
      /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(url),
    "Use https, or http only to localhost: the credential travels with each call",
  );

export const connectField = z
  .object({
    /** Nodrail's address; Cloud when left out. */
    url: controlPlaneUrl.optional(),
    /** The workspace's slug. */
    workspace: slug,
    /** The environment's slug, such as development or production. */
    environment: slug,
    /**
     * The policy source for the host engine: `cloud` fetches the locked
     * policy and reports decisions; `local` uses the repository policy.
     */
    decide: z.enum(["cloud", "local"]),
    /** `on` blocks what the policy blocks; `watch` records it and blocks nothing. */
    enforce: z.enum(["on", "watch"]).default("on"),
    /** The agent credential (`ndr_…`), by reference; never written anywhere. */
    credential: secretRef.optional(),
  })
  .strict()
  .refine((connect) => connect.decide !== "cloud" || connect.credential, {
    message:
      "decide: cloud needs a credential, such as { fromEnv: NODRAIL_CREDENTIAL }",
    path: ["credential"],
  });
export type Connect = z.infer<typeof connectField>;
