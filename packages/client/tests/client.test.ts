import { describe, expect, test, vi } from "vitest";
import { authorize, NodrailClient } from "../src/index";
import {
  actionDigest,
  descriptorDigest,
  type ActionDescriptor,
  type ActionStatus,
} from "../src/protocol";

const INSTALL = "11111111-1111-4111-8111-111111111111";
const ACTION = "22222222-2222-4222-8222-222222222222";

const descriptor: ActionDescriptor = {
  tool: "github",
  operation: "issues.create",
  resource: { kind: "repository", id: "acme/app" },
  params: { title: "Hi" },
};

const digest = descriptorDigest(INSTALL, descriptor);

const status = (overrides: Partial<ActionStatus> = {}): ActionStatus => ({
  code: "READY",
  action_id: ACTION,
  installation_id: INSTALL,
  permit_id: null,
  descriptor_digest: digest,
  action_digest: actionDigest(ACTION, digest),
  reference: "APR-AAAAAAAA",
  reason: null,
  expires_at: "2026-11-09T01:00:00.000Z",
  ...overrides,
});

type Reply = { status?: number; body: unknown } | (() => never);

/** Answers each path in order, echoing the nonce the client generated. */
function fakeFetch(replies: {
  submit?: Reply;
  polls?: Reply[];
  permit?: Reply | ((nonce: string) => Reply);
}) {
  const polls = [...(replies.polls ?? [])];
  const send = vi.fn(async (url: string, init: RequestInit) => {
    let reply: Reply | undefined;
    if (url.endsWith("/permit")) {
      const nonce = (JSON.parse(init.body as string) as { nonce: string })
        .nonce;
      reply =
        typeof replies.permit === "function"
          ? (replies.permit as (nonce: string) => Reply)(nonce)
          : replies.permit;
    } else if (init.method === "POST") reply = replies.submit;
    else reply = polls.shift();
    if (!reply) throw new Error("unexpected call");
    if (typeof reply === "function") return reply();
    return new Response(
      typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body),
      { status: reply.status ?? 200 },
    );
  });
  return send as unknown as typeof fetch;
}

const allow = (nonce: string, overrides: object = {}) => ({
  body: {
    code: "ALLOW",
    permit_id: "p1",
    action_id: ACTION,
    action_digest: actionDigest(ACTION, digest),
    installation_id: INSTALL,
    claim_nonce: nonce,
    policy_version_id: "v1",
    access_epoch: 1,
    issued_at: "2026-11-09T00:00:00.000Z",
    expires_at: "2026-11-09T00:00:05.000Z",
    ...overrides,
  },
});

const run = (send: typeof fetch, waitMs = 0) =>
  authorize(
    new NodrailClient({ url: "http://x", credential: "c", fetch: send }),
    descriptor,
    "key",
    { waitMs, pollMs: 1, sleep: () => Promise.resolve() },
  );

const blockedWith = (code: string) => ({ allowed: false, code });

describe("the one way through", () => {
  test("a fresh, exact ALLOW is allowed", async () => {
    await expect(
      run(fakeFetch({ submit: { body: status() }, permit: allow })),
    ).resolves.toEqual({ allowed: true, actionId: ACTION, permitId: "p1" });
  });

  test("a person's approval arriving while waiting is honoured", async () => {
    await expect(
      run(
        fakeFetch({
          submit: { body: status({ code: "APPROVAL_PENDING" }) },
          polls: [
            { body: status({ code: "APPROVAL_PENDING" }) },
            { body: status() },
          ],
          permit: allow,
        }),
        1000,
      ),
    ).resolves.toMatchObject({ allowed: true });
  });
});

describe("everything else blocks", () => {
  test.each(["DENIED", "EXPIRED", "INVALIDATED", "PERMIT_ISSUED", "NEW_CODE"])(
    "submit answering %s",
    async (code) => {
      await expect(
        run(
          fakeFetch({
            submit: { body: status({ code: code as ActionStatus["code"] }) },
          }),
        ),
      ).resolves.toMatchObject(blockedWith(code));
    },
  );

  test("waiting runs out", async () => {
    await expect(
      run(
        fakeFetch({ submit: { body: status({ code: "APPROVAL_PENDING" }) } }),
      ),
    ).resolves.toMatchObject({
      ...blockedWith("APPROVAL_PENDING"),
      reference: "APR-AAAAAAAA",
    });
  });

  test.each([
    [
      "a network failure",
      () => {
        throw new Error("boom");
      },
      "UNAVAILABLE",
    ],
    ["a 500", { status: 500, body: "oops" }, "UNAVAILABLE"],
    [
      "a 401",
      { status: 401, body: { error: { code: "UNAUTHENTICATED" } } },
      "UNAUTHENTICATED",
    ],
    ["HTML from a proxy", { body: "<html>" }, "INVALID_RESPONSE"],
    ["an empty object", { body: {} }, "INVALID_RESPONSE"],
    ["an array", { body: [] }, "INVALID_RESPONSE"],
  ] as [string, Reply, string][])(
    "submit answering %s",
    async (_l, reply, code) => {
      await expect(run(fakeFetch({ submit: reply }))).resolves.toMatchObject(
        blockedWith(code),
      );
    },
  );

  test("the server describing a different call", async () => {
    await expect(
      run(
        fakeFetch({
          submit: { body: status({ descriptor_digest: "sha256:other" }) },
        }),
      ),
    ).resolves.toMatchObject(blockedWith("DIGEST_MISMATCH"));
  });

  test("an action digest not bound to this action", async () => {
    await expect(
      run(
        fakeFetch({
          submit: {
            body: status({ action_digest: actionDigest("x", digest) }),
          },
        }),
      ),
    ).resolves.toMatchObject(blockedWith("DIGEST_MISMATCH"));
  });

  test.each([
    ["another nonce", { claim_nonce: "stale" }],
    ["another action", { action_id: "other" }],
    ["another digest", { action_digest: "sha256:x" }],
    ["another installation", { installation_id: "other" }],
    ["no permit id", { permit_id: undefined }],
    ["no expiry", { expires_at: undefined }],
    ["an expiry before issue", { expires_at: "2026-11-08T00:00:00.000Z" }],
    ["an implausibly long life", { expires_at: "2026-11-10T00:00:00.000Z" }],
    ["unreadable times", { issued_at: "soon" }],
  ])("a permit with %s", async (_label, overrides) => {
    const decision = await run(
      fakeFetch({
        submit: { body: status() },
        permit: (nonce) => allow(nonce, overrides),
      }),
    );
    expect(decision.allowed).toBe(false);
  });

  test("a permit that arrives after its life", async () => {
    let clock = 0;
    const now = vi.spyOn(Date, "now").mockImplementation(() => {
      clock += 6000;
      return clock;
    });
    const decision = await run(
      fakeFetch({ submit: { body: status() }, permit: allow }),
    );
    now.mockRestore();
    expect(decision).toMatchObject(blockedWith("PERMIT_STALE"));
  });

  test.each([
    ["DENIED", { code: "DENIED", action_id: ACTION, reason: "rule" }],
    ["unknown", { code: "MAYBE" }],
    ["ok true", { ok: true }],
  ])("a permit answering %s", async (_label, body) => {
    const decision = await run(
      fakeFetch({ submit: { body: status() }, permit: { body } }),
    );
    expect(decision.allowed).toBe(false);
  });

  test("a permit already issued", async () => {
    await expect(
      run(
        fakeFetch({
          submit: { body: status() },
          permit: {
            status: 409,
            body: { error: { code: "PERMIT_ALREADY_ISSUED" } },
          },
        }),
      ),
    ).resolves.toMatchObject(blockedWith("PERMIT_ALREADY_ISSUED"));
  });

  test.each([NaN, Infinity])("params holding %s", async (value) => {
    const send = fakeFetch({ submit: { body: status() }, permit: allow });
    const decision = await authorize(
      new NodrailClient({ url: "http://x", credential: "c", fetch: send }),
      { ...descriptor, params: { value } },
      "key",
    );
    expect(decision).toMatchObject(blockedWith("INVALID_ACTION"));
  });
});

describe("digests", () => {
  test("ignore key order", () => {
    const one = { ...descriptor, params: { a: 1, b: [1, 2] } };
    const two = { ...descriptor, params: { b: [1, 2], a: 1 } };
    expect(descriptorDigest(INSTALL, one)).toBe(descriptorDigest(INSTALL, two));
  });

  test.each([
    ["value", { title: "Bye" }],
    ["array order", { title: ["b", "a"] }],
    ["number", { title: 1 }],
  ])("change with the %s", (_label, params) => {
    expect(descriptorDigest(INSTALL, { ...descriptor, params })).not.toBe(
      digest,
    );
  });

  test("change with the installation", () => {
    expect(descriptorDigest("other", descriptor)).not.toBe(digest);
  });

  test("are stable across releases", () => {
    expect(
      descriptorDigest(INSTALL, {
        tool: "t",
        operation: "o.p",
        resource: { kind: "k", id: "é€😀" },
        params: { n: 1e21, f: 0.1, b: true, z: null, u: " " },
      }),
    ).toBe(
      "sha256:5c50c5a2706607519f1ca455cb5f178f6da6ecf8b5581df76ffbf18ebdb31480",
    );
  });
});
