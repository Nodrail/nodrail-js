import { z } from "zod";
import { secretRef } from "./connections.ts";

/** Where Nodrail sends its decisions, as `nodrail.yaml` says; no Node needed. */

const header = z.string().regex(/^[A-Za-z0-9-]{1,100}$/);

export const telemetryField = z
  .object({
    traces: z
      .object({
        endpoint: z.url({ protocol: /^https?$/ }).max(2000),
        protocol: z
          .enum(["otlp-http/protobuf", "otlp-http/json"])
          .default("otlp-http/protobuf"),
        /**
         * A raw token by reference, sent as `Authorization: Bearer <token>`:
         * the same `ndp_` token the CLI uses (reporting contract v2).
         */
        bearer: secretRef.optional(),
        /** Sent with every export, as written; a value by reference. */
        headers: z
          .record(header, z.union([z.string().max(2000), secretRef]))
          .default({}),
      })
      .strict(),
  })
  .strict();
export type Telemetry = z.infer<typeof telemetryField>;

/** What `nodrail apply` writes for the hook: where to send, and as whom. */
export const telemetryFile = z
  .object({
    /** The project's name, for display. */
    project: z.string().max(200),
    /** The project's stable id, from the lock; absent before contract v2. */
    projectId: z.uuid().optional(),
    traces: telemetryField.shape.traces,
  })
  .strict();
export type TelemetryFile = z.infer<typeof telemetryFile>;
