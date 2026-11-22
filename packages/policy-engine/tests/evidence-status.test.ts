// Cloud's evidence status answers, as Cloud sends them (EvidenceStatusDto):
// each fixture is read as is, so a change on either side fails here.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { fetchEvidenceStatus } from "../src/evidence-remote";
import { evidenceShortfall } from "../src/run-evidence";

const fixture = (name: string) =>
  readFileSync(
    join(import.meta.dirname, "fixtures/evidence-status", `${name}.json`),
    "utf8",
  );

/** Cloud answering `body`, read the way the hook reads it. */
const answered = (body: string) =>
  fetchEvidenceStatus(
    {
      url: "https://nodrail.example",
      token: "t",
      workspaceRevision: "rev",
      fetch: (async () => new Response(body)) as unknown as typeof fetch,
    },
    { gate: "tested", index: 0, subject: "sha256:" + "d".repeat(64) },
  );

const need = {
  evidence: "ci-tests",
  contract: "sha256:" + "a".repeat(64),
  where: [],
  authority: "externally-verified" as const,
  subject: "revision" as const,
};

/** Why the requirement is unmet with this answer, or null when met. */
async function shortfall(name: string) {
  const status = await answered(fixture(name));
  return evidenceShortfall(
    need,
    { gate: "tested", index: 0 },
    {
      subject: "sha256:" + "d".repeat(64),
      evidence: { local: () => [], remote: () => status },
    },
  );
}

describe("Cloud's evidence status", () => {
  test.each(["met", "no-event", "where-unmet", "verifier-revoked"])(
    "%s is read exactly as Cloud sends it",
    async (name) => {
      expect(await answered(fixture(name))).toEqual(JSON.parse(fixture(name)));
    },
  );

  test("met meets the requirement; the others say why not", async () => {
    expect(await shortfall("met")).toBeNull();
    expect(await shortfall("no-event")).toBe("no ci-tests for this revision");
    expect(await shortfall("where-unmet")).toBe(
      "the latest ci-tests for this revision doesn't meet the where conditions",
    );
  });

  test("a revoked verifier stays unmet, and says who and when", async () => {
    expect(await shortfall("verifier-revoked")).toBe(
      "the verifier github-actions was revoked on 2026-11-21; its evidence no longer counts",
    );
  });

  test("a code this engine doesn't know is still unmet", async () => {
    const body = JSON.stringify({
      ...JSON.parse(fixture("no-event")),
      reason_code: "something_new",
    });
    const status = await answered(body);
    expect(status).toMatchObject({ met: false, reason_code: "something_new" });
  });

  test("the old shape (verifier as a name) is refused, never read as met", async () => {
    const old = JSON.stringify({
      ...JSON.parse(fixture("met")),
      verifier: "github-actions",
    });
    expect(await answered(old)).toMatchObject({
      met: false,
      reason_code: "error",
    });
  });
});
