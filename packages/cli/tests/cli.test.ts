import {
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  statSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { readSecretFile } from "@nodrail/policy-engine/command-line";
import { describe, expect, test } from "vitest";
import { configPath } from "../src/config.ts";
import { VERSION } from "../src/cli.ts";
import { EVENT_ID, RUN_ID, TOKEN, fakeApi } from "./support/fake-api.ts";
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
    expect(t.stdout()).toContain("nodrail <command>");
    // Nothing waits for a person, so there is nothing to approve.
    expect(t.stdout()).not.toMatch(/approv|reject/i);
    for (const removed of ["approvals", "approve", "reject"]) {
      const gone = fakeIo();
      expect(await gone.run(removed)).toBe(2);
      expect(gone.stderr()).toContain(`Unknown command "${removed}"`);
    }
    expect(await fakeIo().run()).toBe(2);
    const unknown = fakeIo();
    expect(await unknown.run("frobnicate")).toBe(2);
    expect(unknown.stderr()).toContain('Unknown command "frobnicate"');
    const wrongFlag = fakeIo();
    expect(await wrongFlag.run("whoami", "--days", "7")).toBe(2);
    expect(wrongFlag.stderr()).toContain("doesn't take --days");
    expect(await fakeIo().run("whoami", "--nope")).toBe(2);
    expect(await fakeIo().run("whoami", "extra")).toBe(2);
  });

  test("without a token it says how to log in", async () => {
    const t = fakeIo({ fetch: fakeApi().fetch });
    expect(await t.run("whoami")).toBe(1);
    expect(t.stderr()).toContain("nodrail login");
  });
});

const windows = process.platform === "win32";

describe("login", () => {
  test("stores the token for this URL, readable only by its owner", async () => {
    const api = fakeApi();
    const t = fakeIo({ fetch: api.fetch, stdin: `${TOKEN}\n` });
    expect(await t.run("login", "--token-stdin")).toBe(0);
    expect(t.stdout()).toContain("Ana Ruiz in Acme");
    // The mode and the text from one open file, so both are the same file.
    const file = openSync(configPath(t.io.home), "r");
    try {
      const stored = readFileSync(file, "utf8");
      // Windows has no Unix file modes: the token is encrypted for this
      // user instead, so the file never holds it in plain text.
      if (windows) {
        expect(JSON.parse(stored)).toHaveProperty("windows_protected");
        expect(stored).not.toContain(TOKEN);
      } else {
        expect(fstatSync(file).mode & 0o777).toBe(0o600);
      }
      expect(
        JSON.parse(readSecretFile(configPath(t.io.home)) ?? "null"),
      ).toMatchObject({ tokens: { "https://app.nodrail.com": TOKEN } });
    } finally {
      closeSync(file);
    }
    if (!windows)
      expect(statSync(`${t.io.home}/.nodrail`).mode & 0o777).toBe(0o700);

    const again = fakeIo({ fetch: api.fetch, home: t.io.home });
    expect(await again.run("whoami")).toBe(0);
    expect(api.seen.at(-1)?.authorization).toBe(`Bearer ${TOKEN}`);

    const out = fakeIo({ home: t.io.home });
    expect(await out.run("logout")).toBe(0);
    expect(out.stdout()).toContain("can still be revoked");
    const none = fakeIo({ home: t.io.home });
    expect(await none.run("logout")).toBe(0);
    expect(none.stdout()).toContain("No saved token");
  });

  test("runs browser login and reuses the self-hosted origin in a fresh CLI process", async () => {
    const api = fakeApi({ scopes: ["read", "rules:write", "agents:manage"] });
    const origin = "http://127.0.0.1:3301";
    const session = `ndc_${"x".repeat(43)}`;
    let challenge = "";
    let opened = "";
    let workspace = "";
    let revoked = false;
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      const body =
        typeof init?.body === "string" ? JSON.parse(init.body) : null;
      expect(url.origin).toBe(origin);
      expect(init?.redirect).toBe("error");
      if (url.pathname.endsWith("/start")) {
        challenge = body.challenge;
        expect(body.origin).toBe(origin);
        return Response.json({ ok: true });
      }
      if (url.pathname.endsWith("/exchange")) {
        expect(opened).toContain(challenge);
        expect(createHash("sha256").update(body.verifier).digest("hex")).toBe(
          challenge,
        );
        expect(body.origin).toBe(origin);
        return Response.json({ token: session });
      }
      expect(new Headers(init?.headers).get("authorization")).toBe(
        `Bearer ${session}`,
      );
      if (url.pathname.endsWith("/logout")) {
        revoked = true;
        return Response.json({ ok: true });
      }
      workspace = url.searchParams.get("workspace") ?? "";
      const me = await (
        await api.fetch(input, {
          headers: { authorization: `Bearer ${TOKEN}` },
        })
      ).json();
      return Response.json({
        ...me,
        effective_scopes: ["read", "rules:write", "agents:manage"],
      });
    };
    const first = fakeIo({ fetch: fetcher });
    first.io.openBrowser = (url) => {
      opened = url;
    };
    expect(await first.run("login", "--url", origin)).toBe(0);
    expect(first.stdout()).toContain(
      "Can now      read, rules:write, agents:manage",
    );
    expect(first.stdout()).not.toContain(session);
    for (const { args, message } of [
      { args: ["--workspace", "unknown"], message: `Logged in to ${origin}.` },
      {
        args: [],
        message: `Logged in to ${origin}. Create or join a workspace in the console.`,
      },
    ]) {
      const unavailable = fakeIo({
        fetch: (input, init) => {
          const url = new URL(input instanceof Request ? input.url : input);
          if (url.pathname.endsWith("/me"))
            return Promise.resolve(
              Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 }),
            );
          return fetcher(input, init);
        },
      });
      unavailable.io.openBrowser = first.io.openBrowser;
      expect(await unavailable.run("login", "--url", origin, ...args)).toBe(0);
      expect(unavailable.stdout()).toBe(message);
    }

    const again = fakeIo({ home: first.io.home, fetch: fetcher });
    expect(await again.run("whoami")).toBe(0);
    expect(await again.run("whoami", "--workspace", "second")).toBe(0);
    expect(workspace).toBe("second");
    expect(await again.run("logout")).toBe(0);
    expect(revoked).toBe(true);
    expect(await again.run("whoami")).toBe(1);
  });

  test("rejects agent credentials and malformed tokens on stdin", async () => {
    const agent = fakeIo({ stdin: `ndr_0123456789ab_${"A".repeat(43)}` });
    expect(await agent.run("login", "--token-stdin")).toBe(2);
    expect(agent.stderr()).toContain("personal API token");
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
    const t = withToken(fakeApi({ scopes: ["read", "rules:write"] }));
    expect(await t.run("whoami")).toBe(0);
    expect(t.stdout()).toContain("Can now      read, rules:write");
    expect(t.stdout()).toContain("development (default)");
    const json = withToken();
    await json.run("whoami", "--json");
    expect(JSON.parse(json.stdout()).workspace.slug).toBe("acme");
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
    expect(t.stdout()).toContain(
      "Actions 40: 28 allowed, 12 denied (5 because no rule covered them).",
    );
    expect(await t.run("activity", "--kind", "x", "--days", "7")).toBe(2);
  });

  test("an unknown run is NOT_FOUND", async () => {
    const t = withToken();
    expect(await t.run("run", "nope")).toBe(1);
    expect(t.stderr()).toContain("NOT_FOUND");
  });
});
