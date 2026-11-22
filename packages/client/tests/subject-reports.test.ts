// Wave 3 on the client: the work revision a call is about (`run.subject`,
// sent at submit and again at permit), the amounts a result measured, an
// `unknown` outcome when a call wasn't waited for, and reports that can be
// retried without counting twice.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { workRevision } from "@nodrail/policy-engine/revision";
import { describe, expect, test } from "vitest";
import {
  createNodrail,
  NodrailClient,
  REPORT_RETRY_MS,
  type NodrailOptions,
} from "../src/index";
import { fakeNodrail } from "./support/fake-nodrail";
import { scratchFolders } from "./support/folders";

const REVISION = `sha256:${"a".repeat(64)}`;
const LATER = `sha256:${"b".repeat(64)}`;
const action = { tool: "github", operation: "pulls.merge", resource: "a/b" };
const noSleep = () => Promise.resolve();

type Server = ReturnType<typeof fakeNodrail>;

function connect(
  options: Partial<NodrailOptions> = {},
  server: Server = fakeNodrail(),
) {
  const nodrail = createNodrail({
    url: "https://nodrail.test",
    credential: "c",
    waitMs: 0,
    fetch: server.fetch,
    env: {},
    sleep: noSleep,
    ...options,
  });
  return { server, nodrail };
}

const bodies = (server: Server, ending: string) =>
  server.requests
    .filter((request) => request.path.endsWith(ending))
    .map((request) => request.body);

const folder = scratchFolders();

describe("run.subject", () => {
  test("is sent with the run at submit, and read again at permit", async () => {
    const reads = [REVISION, LATER];
    const { server, nodrail } = connect({
      run: "ENG-1",
      subject: () => reads.shift() ?? null,
    });
    expect((await nodrail.check(action)).allowed).toBe(true);
    expect(bodies(server, "/actions")[0]?.run).toEqual({
      key: "ENG-1",
      subject: REVISION,
    });
    // The work may change while a person decides: the permit says what it is now.
    expect(bodies(server, "/permit")[0]?.subject).toBe(LATER);
    expect(reads).toEqual([]);
  });

  test.each([
    ["null", () => null],
    [
      "thrown",
      () => {
        throw new Error("no git");
      },
    ],
    ["not a revision", () => "fresh"],
  ])(
    "an unknown revision (%s) is sent as null, never left out",
    async (_, subject) => {
      const { server, nodrail } = connect({ run: "ENG-2", subject });
      await nodrail.check(action);
      const [submitted] = bodies(server, "/actions");
      expect(submitted?.run).toEqual({ key: "ENG-2", subject: null });
      expect(bodies(server, "/permit")[0]).toHaveProperty("subject", null);
    },
  );

  test("subject: null sends unknown without reading anything", async () => {
    const { server, nodrail } = connect({ run: "ENG-3", subject: null });
    await nodrail.check(action);
    expect(bodies(server, "/actions")[0]?.run).toEqual({
      key: "ENG-3",
      subject: null,
    });
  });

  test("without a run there is no subject to send, and none is read", async () => {
    let read = 0;
    const { server, nodrail } = connect({
      subject: () => {
        read += 1;
        return REVISION;
      },
    });
    await nodrail.check(action);
    expect(bodies(server, "/actions")[0]).not.toHaveProperty("run");
    expect(bodies(server, "/permit")[0]).not.toHaveProperty("subject");
    expect(read).toBe(0);
  });

  test("by default it is the git work tree at cwd; outside one, unknown", async () => {
    const repo = folder("nodrail-subject-");
    const git = (...args: string[]) =>
      spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "T");
    git("config", "commit.gpgsign", "false");
    writeFileSync(join(repo, "a.txt"), "a\n");
    git("add", "a.txt");
    git("commit", "-q", "-m", "a");
    const inRepo = connect({ run: "ENG-4", cwd: repo, subject: undefined });
    await inRepo.nodrail.check(action);
    const expected = workRevision(repo);
    expect(expected).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(bodies(inRepo.server, "/actions")[0]?.run).toEqual({
      key: "ENG-4",
      subject: expected,
    });

    const outside = connect({
      run: "ENG-5",
      cwd: folder("nodrail-no-git-"),
      subject: undefined,
    });
    await outside.nodrail.check(action);
    expect(bodies(outside.server, "/actions")[0]?.run).toEqual({
      key: "ENG-5",
      subject: null,
    });
  });

  test("is not part of the digest: the server's answer for the call still matches", async () => {
    const { nodrail } = connect({ run: "ENG-6", subject: () => REVISION });
    expect((await nodrail.check(action)).allowed).toBe(true);
  });

  test("a server from before Wave 3 that refuses it is asked again without it", async () => {
    const server = fakeNodrail();
    const strict = (async (url: string, init: RequestInit) => {
      const body = init.body
        ? (JSON.parse(init.body as string) as Record<string, unknown>)
        : {};
      const run = body.run as Record<string, unknown> | undefined;
      if ((run && "subject" in run) || "subject" in body)
        return new Response(
          JSON.stringify({ error: { code: "INVALID_INPUT" } }),
          { status: 400 },
        );
      return server.fetch(url, init);
    }) as unknown as typeof fetch;
    const { nodrail } = connect({
      run: "ENG-7",
      subject: () => REVISION,
      fetch: strict,
    });
    expect((await nodrail.check(action)).allowed).toBe(true);
    expect(bodies(server, "/actions")[0]?.run).toEqual({ key: "ENG-7" });
    expect(bodies(server, "/permit")[0]).not.toHaveProperty("subject");
  });
});

describe("reports", () => {
  test("measured amounts go with a successful run's report", async () => {
    const { server, nodrail } = connect();
    const result = await nodrail.run(action, () => ({ amount: 1250 }), {
      measure: (done) => [{ path: "result.amount", value: done.amount }],
    });
    expect(result).toEqual({ amount: 1250 });
    expect(bodies(server, "/reports")[0]).toMatchObject({
      outcome: "success",
      measured: [{ path: "result.amount", value: 1250 }],
    });
  });

  test.each([
    ["a fraction", [{ path: "result.amount", value: 1.5 }]],
    ["a negative amount", [{ path: "result.amount", value: -1 }]],
    ["an unsafe number", [{ path: "result.amount", value: 2 ** 53 }]],
    ["an input path", [{ path: "input.amount", value: 1 }]],
    [
      "a repeated path",
      [
        { path: "result.amount", value: 1 },
        { path: "result.amount", value: 2 },
      ],
    ],
  ])(
    "%s leaves every measured amount out, never part of them",
    async (_, measured) => {
      const { server, nodrail } = connect();
      await nodrail.run(action, () => "done", {
        measure: () => [{ path: "result.fee", value: 3 }, ...measured],
      });
      const [report] = bodies(server, "/reports");
      expect(report?.outcome).toBe("success");
      expect(report).not.toHaveProperty("measured");
    },
  );

  test("the client itself refuses unusable measured amounts", async () => {
    const client = new NodrailClient({
      url: "https://nodrail.test",
      credential: "c",
      fetch: fakeNodrail().fetch,
    });
    await expect(
      client.report("x", {
        key: "k",
        outcome: "success",
        measured: [{ path: "result.amount", value: 0.5 }],
      }),
    ).rejects.toThrow(TypeError);
  });

  test("a call that times out is reported unknown, not failed", async () => {
    const { server, nodrail } = connect();
    await expect(
      nodrail.run(action, () => new Promise(() => undefined), {
        timeoutMs: 20,
      }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(server.reports.map((report) => report.outcome)).toEqual(["unknown"]);
  });

  test("an aborted call is unknown; a thrown error is a failure", async () => {
    const { server, nodrail } = connect();
    const aborted = new DOMException("stopped", "AbortError");
    await expect(
      nodrail.run(action, () => Promise.reject(aborted)),
    ).rejects.toBe(aborted);
    await expect(
      nodrail.run(action, () => {
        throw new Error("refused");
      }),
    ).rejects.toThrow("refused");
    expect(server.reports.map((report) => report.outcome)).toEqual([
      "unknown",
      "failure",
    ]);
  });

  test("a guarded tool that times out is reported unknown", async () => {
    const { server, nodrail } = connect();
    const slow = nodrail.guard(
      async function deploy() {
        throw new DOMException("took too long", "TimeoutError");
      },
      { onBlocked: "throw" },
    );
    await expect(slow()).rejects.toMatchObject({ name: "TimeoutError" });
    expect(server.reports.map((report) => report.outcome)).toEqual(["unknown"]);
  });
});

describe("retrying a report", () => {
  function flaky(answers: number[]) {
    const keys: string[] = [];
    const send = (async (_url: string, init: RequestInit) => {
      keys.push(
        (JSON.parse(init.body as string) as { report_key: string }).report_key,
      );
      const status = answers.shift() ?? 200;
      return new Response(
        JSON.stringify(
          status === 200
            ? { recorded: true }
            : {
                error: {
                  code: status === 409 ? "IDEMPOTENCY_CONFLICT" : "UNAVAILABLE",
                },
              },
        ),
        { status },
      );
    }) as unknown as typeof fetch;
    const client = new NodrailClient({
      url: "https://nodrail.test",
      credential: "c",
      fetch: send,
    });
    const pauses: number[] = [];
    const sleep = (ms: number) => {
      pauses.push(ms);
      return Promise.resolve();
    };
    const report = () =>
      client.report(
        "action",
        { key: "same-key", outcome: "success" },
        { sleep },
      );
    return { keys, pauses, report };
  }

  test("reuses the same key and stops once it is in", async () => {
    const { keys, pauses, report } = flaky([503, 200, 200]);
    await expect(report()).resolves.toEqual({ recorded: true });
    expect(keys).toEqual(["same-key", "same-key"]);
    expect(pauses).toEqual([REPORT_RETRY_MS[0]]);
  });

  test("a key the server already has means the report is in", async () => {
    const { keys, report } = flaky([409]);
    await expect(report()).resolves.toEqual({ recorded: true });
    expect(keys).toEqual(["same-key"]);
  });

  test("gives up after a bounded number of attempts", async () => {
    const { keys, report } = flaky([503, 503, 503, 503, 503]);
    await expect(report()).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(keys).toHaveLength(REPORT_RETRY_MS.length + 1);
  });

  test("the SDK keys a report by its permit, so a second report changes nothing", async () => {
    const { server, nodrail } = connect();
    const decision = await nodrail.check(action);
    if (!decision.allowed) throw new Error("expected an allow");
    await nodrail.report(decision, "success");
    await nodrail.report(decision, "success");
    const keys = bodies(server, "/reports").map((body) => body.report_key);
    expect(keys).toEqual([
      `sdk:${decision.permitId}`,
      `sdk:${decision.permitId}`,
    ]);
  });
});
