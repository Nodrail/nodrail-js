import { readFileSync, statSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { configPath } from "../src/config.ts";
import { VERSION } from "../src/cli.ts";
import {
  APPROVAL_ID,
  EVENT_ID,
  RUN_ID,
  TOKEN,
  fakeApi,
} from "./support/fake-api.ts";
import { fakeIo } from "./support/fake-io.ts";

const withToken = (api = fakeApi(), extra: Parameters<typeof fakeIo>[0] = {}) =>
  fakeIo({ fetch: api.fetch, env: { NODRAIL_TOKEN: TOKEN }, ...extra });

describe("basics", () => {
  test("version matches the package", async () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    const t = fakeIo();
    expect(await t.run("--version")).toBe(0);
    expect(t.stdout()).toBe(pkg.version);
    expect(VERSION).toBe(pkg.version);
  });

  test("help, and usage errors exit 2", async () => {
    const t = fakeIo();
    expect(await t.run("--help")).toBe(0);
    expect(t.stdout()).toContain("nodrail approvals");
    expect(t.stdout()).toContain("not the APR- reference");
    expect(await fakeIo().run()).toBe(2);
    const unknown = fakeIo();
    expect(await unknown.run("frobnicate")).toBe(2);
    expect(unknown.stderr()).toContain('Unknown command "frobnicate"');
    const wrongFlag = fakeIo();
    expect(await wrongFlag.run("whoami", "--watch")).toBe(2);
    expect(wrongFlag.stderr()).toContain("doesn't take --watch");
    expect(await fakeIo().run("whoami", "--nope")).toBe(2);
    expect(await fakeIo().run("whoami", "extra")).toBe(2);
  });

  test("without a token it says how to log in", async () => {
    const t = fakeIo({ fetch: fakeApi().fetch });
    expect(await t.run("whoami")).toBe(1);
    expect(t.stderr()).toContain("nodrail login");
  });
});

describe("login", () => {
  test("stores the token for this URL, readable only by its owner", async () => {
    const api = fakeApi();
    const t = fakeIo({ fetch: api.fetch, stdin: `${TOKEN}\n` });
    expect(await t.run("login", "--token-stdin")).toBe(0);
    expect(t.stdout()).toContain("Ana Ruiz in Acme");
    const path = configPath(t.io.home);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(`${t.io.home}/.nodrail`).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      tokens: { "https://app.nodrail.com": TOKEN },
    });

    const again = fakeIo({ fetch: api.fetch, home: t.io.home });
    expect(await again.run("whoami")).toBe(0);
    expect(api.seen.at(-1)?.authorization).toBe(`Bearer ${TOKEN}`);

    const out = fakeIo({ home: t.io.home });
    expect(await out.run("logout")).toBe(0);
    expect(out.stdout()).toContain("still works until you revoke it");
    const none = fakeIo({ home: t.io.home });
    expect(await none.run("logout")).toBe(0);
    expect(none.stdout()).toContain("No saved token");
  });

  test("asks with hidden input at a terminal", async () => {
    const t = fakeIo({
      fetch: fakeApi().fetch,
      interactive: true,
      answers: [TOKEN],
    });
    expect(await t.run("login")).toBe(0);
    expect(t.asked).toEqual([{ question: "Token: ", hidden: true }]);
  });

  test("refuses without a terminal, agent credentials and bad tokens", async () => {
    expect(await fakeIo().run("login")).toBe(2);
    const agent = fakeIo({ stdin: `ndr_0123456789ab_${"A".repeat(43)}` });
    expect(await agent.run("login", "--token-stdin")).toBe(2);
    expect(agent.stderr()).toContain("agent's credential");
    expect(await fakeIo({ stdin: "nope" }).run("login", "--token-stdin")).toBe(
      2,
    );
  });

  test("a token Nodrail refuses is not saved", async () => {
    const t = fakeIo({
      fetch: fakeApi({ failWith: { status: 401, code: "UNAUTHENTICATED" } })
        .fetch,
      stdin: TOKEN,
    });
    expect(await t.run("login", "--token-stdin")).toBe(1);
    expect(t.stderr()).toContain("UNAUTHENTICATED, request req-1");
    expect(() => statSync(configPath(t.io.home))).toThrow();
  });

  test("NODRAIL_TOKEN wins over the saved token", async () => {
    const api = fakeApi();
    const saved = fakeIo({ fetch: api.fetch, stdin: TOKEN });
    await saved.run("login", "--token-stdin");
    const t = fakeIo({
      fetch: api.fetch,
      home: saved.io.home,
      env: { NODRAIL_TOKEN: "ndp_other" },
    });
    expect(await t.run("whoami")).toBe(1);
    expect(api.seen.at(-1)?.authorization).toBe("Bearer ndp_other");
  });

  test("NODRAIL_URL and --url choose the server", async () => {
    const api = fakeApi();
    const t = withToken(api, {
      env: { NODRAIL_TOKEN: TOKEN, NODRAIL_URL: "https://nodrail.example/" },
    });
    expect(await t.run("whoami")).toBe(0);
    expect(t.stdout()).toContain("Nodrail      https://nodrail.example");
    const local = withToken(api, {
      env: { NODRAIL_TOKEN: TOKEN, NODRAIL_URL: "http://localhost:3000" },
    });
    expect(await local.run("whoami")).toBe(0);
  });

  test("NODRAIL_TOKEN goes only to the Nodrail it was set for", async () => {
    const t = withToken(fakeApi(), { env: { NODRAIL_TOKEN: TOKEN } });
    expect(await t.run("whoami", "--url", "https://attacker.example")).toBe(1);
    expect(t.stderr()).toContain(
      "NODRAIL_TOKEN is only sent to https://app.nodrail.com",
    );
  });

  test("a token never travels over plain http, except to this computer", async () => {
    const t = withToken(fakeApi(), {
      env: { NODRAIL_TOKEN: TOKEN, NODRAIL_URL: "http://nodrail.example" },
    });
    expect(await t.run("whoami")).toBe(1);
    expect(t.stderr()).toContain("must be reached over https");
  });
});

describe("whoami", () => {
  test("text and json", async () => {
    const t = withToken(fakeApi({ scopes: ["read", "decide"] }));
    expect(await t.run("whoami")).toBe(0);
    expect(t.stdout()).toContain("Can now      read, decide");
    expect(t.stdout()).toContain("development (default)");
    const json = withToken();
    await json.run("whoami", "--json");
    expect(JSON.parse(json.stdout()).workspace.slug).toBe("acme");
  });
});

describe("approvals", () => {
  test("lists, filters and prints json", async () => {
    const api = fakeApi();
    const t = withToken(api);
    expect(await t.run("approvals", "--agent", "support-bot")).toBe(0);
    expect(t.stdout()).toContain(APPROVAL_ID);
    expect(t.stdout()).toContain("github.issues.delete");
    expect(api.seen.at(-1)?.query).toEqual({ agent: "support-bot" });
    const json = withToken();
    await json.run("approvals", "--json");
    expect(JSON.parse(json.stdout()).items[0].id).toBe(APPROVAL_ID);
  });

  test("--environment is sent on environment calls", async () => {
    const api = fakeApi();
    await withToken(api).run("approvals", "-e", "production");
    expect(api.seen.at(-1)?.query).toEqual({ environment: "production" });
  });

  test("--watch polls until stopped", async () => {
    const api = fakeApi();
    const t = withToken(api, { polls: 3 });
    expect(await t.run("approvals", "--watch")).toBe(0);
    expect(api.seen.filter((call) => call.path === "/approvals")).toHaveLength(
      3,
    );
    expect(t.clears()).toBe(3);
    expect(t.stdout()).toContain("Ctrl-C to stop");
  });
});

describe("deciding", () => {
  const decider = () =>
    fakeApi({ scopes: ["read", "decide"], role: "approver" });

  test("shows the request, asks, and sends the digest it showed", async () => {
    const api = decider();
    const t = withToken(api, { interactive: true, answers: ["y"] });
    expect(await t.run("approve", APPROVAL_ID)).toBe(0);
    expect(t.stdout()).toContain(
      "Agent        support-bot on support-bot-prod",
    );
    expect(t.stdout()).toContain("Action       github.issues.delete");
    expect(t.stdout()).toContain('"issue": 482');
    expect(t.asked[0]?.question).toContain("Approve this request once?");
    expect(api.seen.at(-1)).toMatchObject({
      method: "POST",
      path: `/approvals/${APPROVAL_ID}/decision`,
      body: { decision: "allow_once", expected_action_digest: "sha256:abc" },
    });
    expect(t.stdout()).toContain("Approved once: APR-6D1C2F0A.");
  });

  test("anything but yes decides nothing", async () => {
    const api = decider();
    const t = withToken(api, { interactive: true, answers: ["n"] });
    expect(await t.run("reject", APPROVAL_ID)).toBe(1);
    expect(t.stderr()).toContain("Nothing was decided");
    expect(api.seen.some((call) => call.method === "POST")).toBe(false);
  });

  test("refuses without a terminal unless --yes", async () => {
    const api = decider();
    expect(await withToken(api).run("approve", APPROVAL_ID)).toBe(2);
    expect(api.seen).toHaveLength(0);
    const t = withToken(api);
    expect(await t.run("reject", APPROVAL_ID, "--yes", "--json")).toBe(0);
    expect(JSON.parse(t.stdout()).state).toBe("denied");
    // With --json the request shown goes to stderr, so stdout parses.
    expect(t.stderr()).toContain("Request      APR-6D1C2F0A");
  });

  test("takes a UUID, not a reference", async () => {
    const t = withToken(decider(), { interactive: true });
    expect(await t.run("approve", "APR-6D1C2F0A")).toBe(2);
    expect(t.stderr()).toContain("UUID");
    expect(await withToken().run("approve")).toBe(2);
  });

  test("a token without the scope is told so, plainly", async () => {
    const t = withToken(fakeApi({ scopes: ["read"] }));
    expect(await t.run("approve", APPROVAL_ID, "--yes")).toBe(1);
    expect(t.stderr()).toContain("doesn't have the scope");
    expect(t.stderr()).toContain("INSUFFICIENT_SCOPE");
  });

  test("a role that can't decide is FORBIDDEN", async () => {
    const t = withToken(
      fakeApi({ scopes: ["read", "decide"], role: "viewer" }),
    );
    expect(await t.run("approve", APPROVAL_ID, "--yes")).toBe(1);
    expect(t.stderr()).toContain("Your role");
  });

  test("a request already decided is not decided again", async () => {
    const api = decider();
    api.approval.state = "denied";
    const t = withToken(api);
    expect(await t.run("approve", APPROVAL_ID, "--yes")).toBe(1);
    expect(t.stderr()).toContain("This request is denied");
  });
});

describe("reading", () => {
  test("activity filters become query parameters", async () => {
    const api = fakeApi();
    const t = withToken(api);
    const filters = ["--q", "issue", "--agent", "bot", "--outcome", "allowed"];
    const more = ["--kind", "decisions", "--range", "7d", "--run", RUN_ID];
    expect(
      await t.run(
        "activity",
        ...filters,
        ...more,
        "--limit",
        "10",
        "--cursor",
        "c",
      ),
    ).toBe(0);
    expect(api.seen.at(-1)?.query).toEqual({
      q: "issue",
      agent: "bot",
      outcome: "allowed",
      kind: "decisions",
      range: "7d",
      run: RUN_ID,
      limit: "10",
      cursor: "c",
    });
    expect(t.stdout()).toContain("Ana Ruiz via API token laptop");
    expect(t.stdout()).toContain("More: --cursor next-page");
    expect(t.stdout()).toContain(EVENT_ID);
  });

  test("runs, a run and insights", async () => {
    const api = fakeApi();
    const t = withToken(api);
    expect(await t.run("runs", "--range", "24h")).toBe(0);
    expect(api.seen.at(-1)?.query).toEqual({ range: "24h" });
    expect(t.stdout()).toContain("ENG-42");
    expect(await t.run("run", RUN_ID)).toBe(0);
    expect(t.stdout()).toContain("qa step s-1 · pass");
    expect(t.stdout()).toContain("github.pulls.create acme/app · ready");
    expect(await t.run("insights", "--days", "7")).toBe(0);
    expect(api.seen.at(-1)?.query).toEqual({ days: "7" });
    expect(t.stdout()).toContain("Median time to decide 42s");
    expect(t.stdout()).toContain("approved 4×");
    expect(await t.run("activity", "--kind", "x", "--watch")).toBe(2);
  });

  test("an unknown run is NOT_FOUND", async () => {
    const t = withToken();
    expect(await t.run("run", "nope")).toBe(1);
    expect(t.stderr()).toContain("NOT_FOUND");
  });
});
