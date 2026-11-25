// `nodrail workspace publish|show` (W4.3): the lock's revision becomes the
// one the team intends, digests only; `show` compares it with the lock and
// each host here.
import { basename } from "node:path";
import { describe, expect, test } from "vitest";
import { TOKEN } from "./support/fake-api.ts";
import { fakeIo } from "./support/fake-io.ts";
import { locked, RESOURCES } from "./support/setup-project.ts";

type Sent = { method: string; path: string; query: string; body: any };

/** The workspace-revisions endpoint, in memory. */
function server() {
  const seen: Sent[] = [];
  let intended: Record<string, unknown> | null = null;
  const fetch = (async (input: URL, init: RequestInit) => {
    const url = new URL(input);
    const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
    seen.push({
      method: init.method!,
      path: url.pathname,
      query: url.search,
      body,
    });
    if (init.method === "POST") {
      const previous = (intended?.revision as string) ?? null;
      intended = {
        ...body,
        published_by: "Ada",
        published_at: "2026-11-20T10:00:00Z",
      };
      return Response.json({ revision: intended, previous });
    }
    return Response.json({ revision: intended });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, seen };
}

const ID = "6b1f0c2e-8d4a-4f3b-9c7e-2a5d1e0f3b4c";

async function project(id: string | null = ID) {
  const p = await locked({
    ...RESOURCES,
    "nodrail.yaml": `${id ? `id: ${id}\n` : ""}${RESOURCES["nodrail.yaml"]}`,
  });
  const api = server();
  const run = async (answers: string[], ...argv: string[]) => {
    const t = fakeIo({
      cwd: p.cwd,
      home: p.home,
      fetch: api.fetch,
      env: { NODRAIL_TOKEN: TOKEN },
      interactive: answers.length > 0,
      answers,
    });
    const code = await t.run(...argv);
    return { code, out: t.stdout(), err: t.stderr() };
  };
  return { p, api, run };
}

describe("nodrail workspace", () => {
  test("publish sends the lock's revision and file digests, after asking", async () => {
    const { p, api, run } = await project();
    const lock = p.read("nodrail.lock.yaml");
    const revision = /workspace:\n {2}sha256: "([0-9a-f]{64})"/.exec(lock)![1]!;
    const published = await run(["yes"], "workspace", "publish");
    expect(published.code).toBe(0);
    const post = api.seen.find((call) => call.method === "POST")!;
    expect(post.path).toBe("/api/v1/workspace-revisions");
    expect(post.body.project).toBe(basename(p.cwd));
    expect(post.body.project_id).toBe(ID);
    expect(api.seen[0]!.query).toBe(`?project_id=${ID}`);
    expect(post.body.revision).toBe(revision);
    expect(
      post.body.files.map((file: { path: string }) => file.path),
    ).toContain("nodrail.yaml");
    for (const file of post.body.files)
      expect(Object.keys(file)).toEqual(["path", "sha256"]);
    expect(published.out).toContain(
      `Published workspace ${revision.slice(0, 12)}`,
    );

    // The same revision again: nothing to publish.
    expect((await run(["yes"], "workspace", "publish")).out).toContain(
      "already intends",
    );
    expect(api.seen.filter((call) => call.method === "POST")).toHaveLength(1);
  });

  test("no id: nothing is published, and the message names one to add", async () => {
    const { api, run } = await project(null);
    const answer = await run(["yes"], "workspace", "publish");
    expect(answer.code).toBe(1);
    expect(answer.err).toMatch(/has no id[\s\S]*Add `id: [0-9a-f-]{36}`/);
    expect(api.seen).toEqual([]);
  });

  test("declined, or no one to ask: nothing is published", async () => {
    const { api, run } = await project();
    expect((await run(["n"], "workspace", "publish")).code).toBe(1);
    expect((await run([], "workspace", "publish")).code).toBe(2);
    expect(api.seen.some((call) => call.method === "POST")).toBe(false);
  });

  test("show compares the intended revision with the lock and each host", async () => {
    const { p, run } = await project();
    expect((await run([], "workspace", "show")).out).toContain(
      "no revision published yet",
    );
    await p.run("apply", "--yes");
    await run(["yes"], "workspace", "publish");
    const shown = await run([], "workspace", "show");
    expect(shown.out).toMatch(
      /your team intends workspace [0-9a-f]{12}, published by Ada/,
    );
    expect(shown.out).toContain(", as intended");
    expect(shown.out).toMatch(
      /claude-code: applied from [0-9a-f]{12}, as intended/,
    );

    p.write("resources/lead.md", "You lead the release, carefully.\n");
    await p.run("policy", "lock");
    const moved = await run([], "workspace", "show");
    expect(moved.out).toContain("differs: pull, or publish it");
  });
});
