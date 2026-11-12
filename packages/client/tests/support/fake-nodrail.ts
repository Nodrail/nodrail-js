import {
  actionDigest,
  descriptorDigest,
  type ActionDescriptor,
} from "../../src/protocol";

const INSTALLATION = "11111111-1111-4111-8111-111111111111";

type Stored = { id: string; descriptor: ActionDescriptor; code: string };

/** The runtime API's contract in memory, for tests about what surrounds it. */
export function fakeNodrail(
  answer: (descriptor: ActionDescriptor) => string = () => "READY",
) {
  const actions = new Map<string, Stored>();
  const reports: { outcome: string; descriptor: ActionDescriptor }[] = [];
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  let count = 0;

  const status = (action: Stored) => {
    const digest = descriptorDigest(INSTALLATION, action.descriptor);
    return {
      code: action.code,
      action_id: action.id,
      installation_id: INSTALLATION,
      permit_id: null,
      descriptor_digest: digest,
      action_digest: actionDigest(action.id, digest),
      reference: "APR-TEST0001",
      reason: null,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    };
  };

  const send = (async (input: string, init: RequestInit) => {
    const path = String(input).split("/api/v1/runtime")[1] ?? "";
    const body = init.body
      ? (JSON.parse(init.body as string) as Record<string, unknown>)
      : {};
    const json = (value: unknown) =>
      new Response(JSON.stringify(value), { status: 200 });
    requests.push({ path, body });
    if (path === "/heartbeat") return json({ ok: true });
    if (path === "/steps") return json({ recorded: true });
    if (path === "/actions") {
      count += 1;
      const { tool, operation, resource, params } = body;
      const descriptor = {
        tool,
        operation,
        resource,
        params,
      } as ActionDescriptor;
      const action = {
        id: `22222222-2222-4222-8222-${String(count).padStart(12, "0")}`,
        descriptor,
        code: answer(descriptor),
      };
      actions.set(action.id, action);
      return json(status(action));
    }
    const [, id, verb] = path.split("/").slice(1);
    const action = actions.get(id ?? "");
    if (!action) return new Response("{}", { status: 404 });
    if (verb === "permit") {
      const issued = new Date();
      return json({
        code: "ALLOW",
        permit_id: `permit-${action.id}`,
        action_id: action.id,
        action_digest: status(action).action_digest,
        installation_id: INSTALLATION,
        claim_nonce: body.nonce,
        issued_at: issued.toISOString(),
        expires_at: new Date(issued.getTime() + 30_000).toISOString(),
      });
    }
    if (verb === "reports") {
      reports.push({
        outcome: body.outcome as string,
        descriptor: action.descriptor,
      });
      return json({ ok: true });
    }
    return json(status(action));
  }) as unknown as typeof fetch;

  return {
    fetch: send,
    reports,
    requests,
    seen: () => [...actions.values()].map((action) => action.descriptor),
  };
}
