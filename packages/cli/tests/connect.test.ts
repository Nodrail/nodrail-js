// Plan explains the policy source and checks the connected credential.
import { describe, expect, test } from "vitest";
import { credentialChecks } from "../src/setup/connect.ts";
import { locked, RESOURCES } from "./support/setup-project.ts";

const connected = (block: string) =>
  locked({
    ...RESOURCES,
    "nodrail.yaml": `${RESOURCES["nodrail.yaml"]}connect:\n${block}`,
  });

describe("connect: in plan and apply", () => {
  test("decide: local says so, and apply goes ahead as before", async () => {
    const p = await connected("  decide: local\n");
    const plan = await p.run("plan");
    expect(plan.code).toBe(0);
    expect(plan.out).toContain(
      "The host decides using repository policy (decide: local).",
    );
    expect((await p.run("apply", "--yes")).code).toBe(0);
  });

  test("decide: cloud without an id: plan names what's missing, apply writes nothing", async () => {
    const p = await connected(
      "  url: http://localhost:3201\n  workspace: acme\n  environment: development\n  decide: cloud\n  credential: { fromEnv: NODRAIL_CREDENTIAL }\n",
    );
    p.env.NODRAIL_URL = "http://localhost:3201";
    p.env.NODRAIL_CREDENTIAL = "ndr_000000000000_" + "A".repeat(43);
    const plan = await p.run("plan");
    expect(plan.code).toBe(1);
    expect((await p.run("plan", "--details")).out).toContain(
      "See decisions in Activity and grouped runs in Activity → Runs.",
    );
    expect(plan.out).not.toMatch(/Approvals|Reviews/);
    expect(plan.out).toMatch(/Add id: [a-f0-9-]+ to nodrail.yaml/);
    // Offline here: the credential is set but couldn't be checked.
    expect(plan.out).toContain(
      "http://localhost:3201 did not answer. Check the connection and run nodrail plan again.",
    );
    expect(plan.out).not.toContain("AAAA");
    const apply = await p.run("apply", "--yes");
    expect(apply.code).toBe(1);
    expect(() => p.read(".claude/settings.json")).toThrow();
  });

  test("enforce: watch is planned and applied", async () => {
    const p = await connected(
      "  workspace: acme\n  environment: development\n  decide: local\n  enforce: watch\n",
    );
    const plan = await p.run("plan");
    expect(plan.code).toBe(0);
    expect(plan.out).toContain("Watch mode records policy decisions");
    expect((await p.run("apply", "--yes")).code).toBe(0);
  });

  test("works beside declared contracts in the same nodrail.yaml", async () => {
    const p = await connected(
      "  workspace: acme\n  environment: development\n  decide: local\nshapes:\n  qa-result:\n    properties:\n      result: { values: [pass, fail], role: verdict }\nreceipts:\n  publisher: { shape: qa-result, format: header }\n",
    );
    const plan = await p.run("plan");
    expect(plan.err).toBe("");
    expect(plan.code).toBe(0);
    expect(plan.out).toContain("decide: local");
  });

  test("without connect:, plan says nothing about it", async () => {
    const p = await locked(RESOURCES);
    const plan = await p.run("plan");
    expect(plan.out).not.toContain("Connected to");
    expect(plan.out).not.toContain("connect:");
  });
});

describe("the credential check", () => {
  const setup = {
    connect: {
      url: "https://nodrail.example",
      workspace: "acme",
      environment: "development",
      decide: "cloud" as const,
      enforce: "on" as const,
      credential: { fromEnv: "NODRAIL_CREDENTIAL" },
    },
  };
  const env = {
    NODRAIL_CREDENTIAL: "ndr_secret_value",
    NODRAIL_URL: setup.connect.url,
  };
  const answering = (status: number, body: unknown = {}) => {
    const seen: { url: string; authorization: string | null }[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      seen.push({
        url,
        authorization: new Headers(init.headers).get("authorization"),
      });
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
    return { seen, fetcher };
  };

  test("a manifest cannot send an environment credential to another origin", async () => {
    const { seen, fetcher } = answering(200);
    const [check] = await credentialChecks(
      setup,
      { ...env, NODRAIL_URL: "https://issuer.test" },
      fetcher,
    );
    expect(check).toMatchObject({
      ok: false,
      detail: expect.stringContaining("Pair NODRAIL_URL"),
    });
    expect(seen).toEqual([]);
  });

  test("accepted, for the workspace and environment connect: names", async () => {
    const { seen, fetcher } = answering(200, {
      workspace: "acme",
      environment: "development",
      agent: "claude-luca",
    });
    expect(await credentialChecks(setup, env, fetcher)).toEqual([
      {
        name: "credential NODRAIL_CREDENTIAL",
        ok: true,
        detail: "accepted: agent claude-luca in acme/development",
      },
    ]);
    expect(seen).toEqual([
      {
        url: "https://nodrail.example/api/v1/runtime/identity",
        authorization: "Bearer ndr_secret_value",
      },
    ]);
  });

  test("holds a runtime secret back from a different origin", async () => {
    const { seen, fetcher } = answering(200);
    const checks = await credentialChecks(
      setup,
      { ...env, NODRAIL_URL: "https://other.example" },
      fetcher,
    );
    expect(checks[0]).toMatchObject({ ok: false });
    expect(seen).toEqual([]);
  });

  test("another environment's credential fails, naming both", async () => {
    const { fetcher } = answering(200, {
      workspace: "acme",
      environment: "production",
      agent: "claude-luca",
    });
    const [check] = await credentialChecks(setup, env, fetcher);
    expect(check).toMatchObject({ ok: false });
    expect(check!.detail).toContain("environment production, not development");
  });

  test("refused, missing, offline and older servers", async () => {
    const refused = await credentialChecks(setup, env, answering(401).fetcher);
    expect(refused[0]).toMatchObject({ ok: false });
    expect(refused[0]!.detail).toMatch(/^refused by https:\/\/nodrail.example/);

    const missing = await credentialChecks(
      setup,
      { NODRAIL_URL: env.NODRAIL_URL },
      answering(200).fetcher,
    );
    expect(missing[0]).toMatchObject({ ok: false });
    expect(missing[0]!.detail).toMatch(/^NODRAIL_CREDENTIAL isn't set/);

    const offline = await credentialChecks(setup, env, (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as unknown as typeof fetch);
    expect(offline[0]).toMatchObject({ ok: false });

    const older = await credentialChecks(setup, env, answering(404).fetcher);
    expect(older[0]).toMatchObject({ ok: false });
    expect(older[0]!.detail).toContain("can't say whose credential this is");
  });

  test("a value never appears in what plan prints", async () => {
    const checks = [
      ...(await credentialChecks(setup, env, answering(401).fetcher)),
      ...(await credentialChecks(
        setup,
        env,
        answering(200, {
          workspace: "other",
          environment: "development",
          agent: "x",
        }).fetcher,
      )),
    ];
    expect(JSON.stringify(checks)).not.toContain("ndr_secret_value");
  });
});
