import { z } from "zod";
import { canonicalOrigin } from "./control-plane-origin.ts";
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
  .string()
  .max(2000)
  .superRefine((value, context) => {
    try {
      canonicalOrigin(value);
    } catch (error) {
      context.addIssue({ code: "custom", message: (error as Error).message });
    }
  });

export const connectField = z
  .object({
    /** Nodrail's address; Cloud when left out. */
    url: controlPlaneUrl.optional(),
    /** The workspace's slug. */
    workspace: slug.optional(),
    /** The environment's slug, such as development or production. */
    environment: slug.optional(),
    /**
     * The policy source for the host engine: `cloud` fetches the locked
     * policy and reports decisions; `local` uses the repository policy.
     */
    decide: z.enum(["cloud", "local"]),
    /** `on` blocks what the policy blocks; `watch` records it and blocks nothing. */
    enforce: z.enum(["on", "watch"]).default("on"),
    /** The agent credential (`ndr_…`), by reference; never written anywhere. */
    credential: secretRef.optional(),
    /** Include the redacted descriptor and policy explanation in decision reports. */
    report_arguments: z.boolean().optional(),
  })
  .strict()
  .refine((connect) => connect.decide !== "cloud" || connect.workspace, {
    message: "decide: cloud needs the workspace slug from your Nodrail console",
    path: ["workspace"],
  })
  .refine((connect) => connect.decide !== "cloud" || connect.environment, {
    message:
      "decide: cloud needs the environment slug from your Nodrail console",
    path: ["environment"],
  });
export type Connect = z.infer<typeof connectField>;
