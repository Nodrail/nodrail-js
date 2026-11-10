import { createHash } from "node:crypto";
import canonicalize from "canonicalize";
import type { JsonValue } from "./json";

export { isPlainJson, type JsonValue } from "./json";

export const SCHEMA_VERSION = 1;
export const CANONICALIZER_VERSION = 1;

export type ActionDescriptor = {
  tool: string;
  operation: string;
  resource: { kind: string; id: string };
  params: Record<string, JsonValue>;
};

const sha256 = (text: string) =>
  `sha256:${createHash("sha256").update(text).digest("hex")}`;

/** The fingerprint of any JSON value, using the same canonical form as digests. */
export function fingerprint(value: unknown) {
  const canonical =
    typeof value === "string" ? value : canonicalize(value ?? null);
  if (canonical === undefined) throw new Error("Value is not serialisable");
  return sha256(canonical);
}

export function descriptorDigest(
  installationId: string,
  descriptor: ActionDescriptor,
) {
  const canonical = canonicalize({
    canonicalizer: CANONICALIZER_VERSION,
    installation: installationId,
    operation: descriptor.operation,
    params: descriptor.params,
    resource: descriptor.resource,
    schema: SCHEMA_VERSION,
    tool: descriptor.tool,
  });
  if (canonical === undefined)
    throw new Error("Descriptor is not serialisable");
  return sha256(canonical);
}

export const actionDigest = (actionId: string, digest: string) =>
  sha256(`nodrail:action:v1\n${actionId}\n${digest}`);

export const nonceDigest = (nonce: string) =>
  sha256(`nodrail:nonce:v1\n${nonce}`);

export type ActionCode =
  | "READY"
  | "APPROVAL_PENDING"
  | "UNKNOWN_PERMISSION_BLOCKED"
  | "DENIED"
  | "EXPIRED"
  | "INVALIDATED"
  | "PERMIT_ISSUED";

export type ActionStatus = {
  code: ActionCode;
  action_id: string;
  installation_id: string;
  permit_id: string | null;
  descriptor_digest: string;
  action_digest: string;
  reference: string;
  reason: string | null;
  expires_at: string;
};

export type PermitAllow = {
  code: "ALLOW";
  permit_id: string;
  action_id: string;
  action_digest: string;
  installation_id: string;
  claim_nonce: string;
  policy_version_id: string;
  access_epoch: number;
  issued_at: string;
  expires_at: string;
};

export type PermitBlocked = {
  code: Exclude<ActionCode, "READY" | "PERMIT_ISSUED">;
  action_id: string;
  reason: string | null;
};

export type PermitResponse = PermitAllow | PermitBlocked;
export type ReportOutcome = "success" | "failure" | "unknown";
