// What level 5 shows and reads beyond the decision: Cloud's answers for
// externally verified evidence (asked only for covering gates, positive
// answers cached), every budget explanation, the run listing, and what a
// changed budget or evidence requirement does to permissions.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  explainLimit,
  limitState,
  mediatedSettlement,
  type LimitState,
} from "../src/budget-ledger";
import { evidenceFile, readEvidence, recordEvidence } from "../src/evidence";
import { readRemoteConfig, remoteStatuses } from "../src/evidence-remote";
import { hookEvidence } from "../src/hook-evidence";
import { budgetAspects, evidenceAspects } from "../src/permission-budgets";
import { permissionChanges } from "../src/permission-changes";
import { evidenceOf } from "../src/policies";
import type { NumericBudget, PolicyDocument } from "../src/policies";
import * as revision from "../src/revision";
import { evidenceShortfall } from "../src/run-evidence";
import { compilePolicies } from "../src/yaml";
import { cli } from "./run-cli.ts";
import { scratchRepo } from "./support/hook-answers.ts";

// These tests build real git repositories; spawning git is slow on Windows
// runners, far past the default 5 s, though nothing hangs.
const GIT_TESTS = 30_000;

const at = "2026-11-21T12:00:00.000Z";
const now = new Date(at);

const documentOf = (text: string) => {
  const result = compilePolicies([{ name: "rules.yaml", text }]);
  if (!result.ok)
    throw new Error(result.issues.map((i) => i.message).join("\n"));
  return result.document;
};

const VERIFIED = `- required_engine_version: 5
- contracts:
    shapes:
      ci-result:
        properties:
          status: { values: [passed, failed], report: true }
    evidence:
      ci-tests:
        shape: ci-result
        producers: [{ class: externally-verified, verifier: github-actions }]
        subject: revision
- rule: Push
  command: { prefix: git push }
  effect: allow
- gate: Tested before a push
  id: tested
  command: { prefix: git push }
  requires:
    - { evidence: ci-tests, authority: externally-verified, subject: revision }
  otherwise: deny
`;

function committed(rules: string) {
  const repo = scratchRepo(rules, "nodrail-reads-", "work");
  const git = (...args: string[]) => spawnSync("git", args, { cwd: repo.repo });
  git("add", "rules.yaml");
  git(
    "-c",
    "user.email=t@example.com",
    "-c",
    "user.name=T",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "-m",
    "one",
  );
  return repo;
}

const pushEvent = (cwd?: string) =>
  JSON.stringify({
    hook_event_name: "PreToolUse",
    session_id: "s",
    cwd,
    tool_name: "Bash",
    tool_input: { command: "git push" },
    tool_use_id: "p1",
  });

describe("Cloud's answers in the hook", { timeout: GIT_TESTS }, () => {
  test("asked only for a covering gate's unmet requirement; a positive answer is cached", async () => {
    // Exercise the hook and cache on a stable revision. revision.test.ts
    // covers reading the revision from a real Git worktree.
    using git = vi
      .spyOn(revision, "workRevision")
      .mockReturnValue(revision.cleanRevision("a".repeat(40)));
    const repo = mkdtempSync(join(tmpdir(), "nodrail-reads-"));
    const document = documentOf(VERIFIED);
    const asked: string[] = [];
    const answer = (met: boolean) =>
      (async (url: string) => {
        asked.push(url);
        return new Response(
          JSON.stringify({
            met,
            reason_code: met ? "met" : "no_event",
            event_id: met ? "e1" : null,
            verifier: met ? { name: "github-actions", revoked_at: null } : null,
            received_at: at,
          }),
        );
      }) as unknown as typeof fetch;
    const options = { document, now, unmatched: "deny" as const };
    const config = (send: typeof globalThis.fetch) => ({
      url: "https://nodrail.example",
      token: "t",
      workspaceRevision: "rev-1",
      fetch: send,
    });
    const env = {
      NODRAIL_LEDGER: mkdtempSync(join(tmpdir(), "nodrail-ledger-")),
    };
    // A call no gate covers asks nothing.
    const other = pushEvent(repo).replace("git push", "ls");
    await hookEvidence(other, options, { env, config: config(answer(true)) });
    expect(git).not.toHaveBeenCalled();
    expect(asked).toEqual([]);
    const reader = await hookEvidence(pushEvent(repo), options, {
      env,
      config: config(answer(true)),
    });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("gate=tested&requirement=0&subject=sha256");
    expect(reader?.remote("tested", 0)?.met).toBe(true);
    // Cached: Cloud down, the positive answer still stands for 5 minutes.
    const down = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    const cached = await hookEvidence(pushEvent(repo), options, {
      env,
      config: config(down),
    });
    expect(cached?.remote("tested", 0)?.met).toBe(true);
    // The cache expires and the hook asks Cloud again.
    const later = { ...options, now: new Date(now.getTime() + 6 * 60_000) };
    const negative = await hookEvidence(pushEvent(repo), later, {
      env,
      config: config(answer(false)),
    });
    expect(negative?.remote("tested", 0)?.reason_code).toBe("no_event");
    expect(asked).toHaveLength(2);
    expect(git).toHaveBeenCalledTimes(3);
  });

  test("without --evidence, or with no token, only local evidence is read", async () => {
    const repo = committed(VERIFIED);
    const options = {
      document: documentOf(VERIFIED),
      now,
      unmatched: "deny" as const,
    };
    const reader = await hookEvidence(pushEvent(repo.repo), options, {
      env: {},
    });
    expect(reader?.remote("tested", 0)).toBeNull();
    const file = join(repo.repo, "evidence.json");
    writeFileSync(
      file,
      JSON.stringify({ url: "https://n.example", workspace_revision: "r" }),
    );
    expect(readRemoteConfig(file, {})).toBeNull();
    expect(readRemoteConfig(file, { NODRAIL_TOKEN: "tok" })).toMatchObject({
      url: "https://n.example",
      token: "tok",
      workspaceRevision: "r",
    });
    // A rule file with no evidence never reads any.
    expect(
      await hookEvidence(
        pushEvent(repo.repo),
        {
          ...options,
          document: documentOf("- rule: R\n  command: ls\n  effect: allow\n"),
        },
        { env: {} },
      ),
    ).toBeNull();
    // The hook command takes the file and reads the token from its environment.
    const run = await cli(
      ["hook", repo.file, "--evidence", file],
      pushEvent(repo.repo),
    );
    expect(run.stdout).toContain("deny");
  }, 15_000);

  test("no ask when nothing is configured or the revision is unknown", async () => {
    expect(
      await remoteStatuses(null, [{ gate: "g", index: 0, subject: "s" }], {
        ledger: "/nonexistent",
        now,
      }),
    ).toEqual(new Map());
  });

  test("a covering gate cannot request remote evidence without a Git revision", async ({
    onTestFinished,
  }) => {
    using git = vi.spyOn(revision, "workRevision").mockReturnValue(null);
    const send = vi.fn<typeof fetch>();
    const folder = mkdtempSync(join(tmpdir(), "nodrail-no-revision-"));
    onTestFinished(() => rmSync(folder, { recursive: true, force: true }));
    const reader = await hookEvidence(
      pushEvent(),
      { document: documentOf(VERIFIED), now, unmatched: "deny" },
      {
        env: { NODRAIL_LEDGER: folder },
        config: {
          url: "https://nodrail.example",
          token: "t",
          workspaceRevision: "rev-1",
          fetch: send,
        },
      },
    );
    expect(git).toHaveBeenCalledTimes(1);
    expect(git).toHaveBeenCalledWith(process.cwd());
    expect(reader?.remote("tested", 0)).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });
});

describe("why evidence falls short", { timeout: GIT_TESTS }, () => {
  const need = {
    evidence: "ci-tests",
    contract: "sha256:" + "a".repeat(64),
    where: [],
    authority: "runtime-observed" as const,
    subject: "revision" as const,
  };
  const reading = (status: object | null, local: never[] = []) => ({
    subject: "sha256:" + "d".repeat(64),
    evidence: {
      local: () => local,
      remote: () =>
        status === null
          ? null
          : ({
              met: false,
              event_id: null,
              verifier: null,
              received_at: null,
              ...status,
            } as never),
    },
  });
  const where = { gate: "g", index: 0 };

  test.each([
    ["subject_unknown", "can't be read"],
    ["no_event", "no ci-tests for this revision"],
    ["authority", "here is below"],
    ["producer_not_allowed", "a verifier this requirement doesn't accept"],
    ["contract_mismatch", "another revision of its contract"],
    ["invalid", "is invalid"],
    ["where_unmet", "doesn't meet the where conditions"],
    ["error", "Cloud couldn't confirm ci-tests"],
    ["unpublished", "isn't published"],
    ["unauthorized", "read scope"],
    ["offline", "couldn't be reached"],
    ["something-new", "Cloud couldn't confirm ci-tests"],
  ])("Cloud's %s is said in words", (code, words) => {
    const verified = { ...need, authority: "externally-verified" as const };
    expect(
      evidenceShortfall(verified, where, reading({ reason_code: code })),
    ).toContain(words);
  });

  test("a met answer from Cloud meets a runtime-observed requirement too; without a reader, unmet", () => {
    expect(
      evidenceShortfall(need, where, {
        ...reading(null),
        evidence: {
          local: () => [],
          remote: () => ({
            met: true,
            reason_code: "met",
            event_id: "e",
            verifier: { name: "v", revoked_at: null },
            received_at: at,
          }),
        },
      }),
    ).toBeNull();
    expect(
      evidenceShortfall(need, where, { subject: null, evidence: null }),
    ).toBe("the current revision can't be read");
    expect(
      evidenceShortfall(need, where, { subject: "s", evidence: null }),
    ).toBe("ci-tests can't be read here");
    expect(
      evidenceShortfall(need, where, reading({ reason_code: "no_event" })),
    ).toBe("no ci-tests for this revision");
  });

  test("local events: dirty tree, class below the authority, missing and invalid results", () => {
    const event = (over: object) =>
      ({
        type: "evidence.recorded",
        event: randomUUID(),
        evidence: "ci-tests",
        contract: need.contract,
        projection: need.contract,
        producer: { class: "runtime-observed", id: "cli" },
        subject: { kind: "revision", digest: "sha256:" + "d".repeat(64) },
        observed: { exit_code: 0, started_at: at, finished_at: at },
        validation: { state: "valid", issues: [] },
        value: { status: "passed" },
        ...over,
      }) as never;
    const clean = "sha256:" + "e".repeat(64);
    expect(
      evidenceShortfall(need, where, {
        ...reading(null, [
          event({ subject: { kind: "revision", digest: clean } }),
        ]),
        clean,
      }),
    ).toContain("uncommitted or untracked changes");
    expect(
      evidenceShortfall(
        need,
        where,
        reading(null, [
          event({ validation: { state: "missing", issues: [] }, value: null }),
        ]),
      ),
    ).toContain("its command wrote none");
    expect(
      evidenceShortfall(
        need,
        where,
        reading(null, [
          event({
            validation: {
              state: "invalid",
              issues: [{ path: "status", code: "enum" }],
            },
            value: null,
          }),
        ]),
      ),
    ).toContain("status: enum");
    expect(
      evidenceShortfall(
        { ...need, authority: "externally-verified" },
        where,
        reading(null, [event({})]),
      ),
    ).toContain("only Cloud can confirm");
  });

  test("evidence files skip unreadable lines and dedupe events", () => {
    const repo = committed(VERIFIED);
    const ledger = join(repo.repo, ".ledger");
    const event = {
      type: "evidence.recorded" as const,
      event: randomUUID(),
      evidence: "ci-tests",
      contract: need.contract,
      projection: need.contract,
      producer: { class: "runtime-observed" as const, id: "cli" },
      subject: {
        kind: "revision" as const,
        digest: revision.workRevision(repo.repo)!,
      },
      observed: { exit_code: 0, started_at: at, finished_at: at },
      validation: { state: "valid" as const, issues: [] },
      value: { status: "passed" },
    };
    expect(readEvidence(ledger, "ci-tests")).toEqual([]);
    recordEvidence(ledger, event);
    writeFileSync(evidenceFile(ledger, "ci-tests"), "not json", { flag: "a" });
    recordEvidence(ledger, event);
    expect(existsSync(evidenceFile(ledger, "ci-tests"))).toBe(true);
    expect(readEvidence(ledger, "ci-tests")).toHaveLength(1);
  });
});

const BUDGET = `- required_engine_version: 5
- budget: Publications
  id: publications
  count: { tool: outbox, operation: publish }
  limit: 3
  per: run
  otherwise: deny
`;
const limitsOf = (document: PolicyDocument) =>
  document.version === 4 ? document.limits : [];
const [publications] = limitsOf(documentOf(BUDGET)) as [NumericBudget];

describe("budget words", { timeout: GIT_TESTS }, () => {
  const state = (over: Partial<LimitState>): LimitState => ({
    id: "b",
    name: "B",
    label: "enforced-allowance",
    unit: "calls",
    limit: 3,
    used: 3,
    reserved: 0,
    unknown: 0,
    unread: 0,
    amount: 1,
    state: "over",
    effect: "deny",
    resets: null,
    ...over,
  });
  test.each([
    [
      state({ state: "shared" }),
      "shared budgets are enforced only on a Cloud-managed connection",
    ],
    [state({ state: "uncounted" }), "neither counts it here"],
    [state({ state: "no_run" }), "needs a run to count calls"],
    [
      state({ state: "unknown", amount: null }),
      "can't know what this call adds",
    ],
    [
      state({
        state: "unknown",
        label: "measured-usage",
        unit: "tokens",
        unread: 2,
      }),
      "2 steps unknown",
    ],
    [
      state({ resets: "2026-11-22T00:00:00.000Z" }),
      "it resets at 2026-11-22T00:00:00.000Z",
    ],
    [state({ unknown: 1 }), "1 unknown"],
    [
      state({ state: "ok", used: 1 }),
      "is at 1 of 3 calls (enforced allowance).",
    ],
  ])("%#", (limit, words) => {
    expect(explainLimit(limit)).toContain(words);
  });

  test("a sum of a result counts what was measured; a sum whose input can't be read holds", () => {
    const refunds: NumericBudget = {
      ...publications,
      id: "refunds",
      measure: {
        kind: "sum",
        tool: "stripe",
        operation: "refund",
        path: "result.fee",
      },
      unit: "usd_cents",
      source: "measured",
      label: "measured-usage",
      limit: 100,
    };
    const events = mediatedSettlement(
      [],
      {
        event: randomUUID(),
        connection: "stripe",
        operation: "refund",
        input_sha256: "sha256:" + "a".repeat(64),
        settlement: "consumed",
        measured: [
          { path: "result.fee", value: 60 },
          { path: "result.fee", value: -1 },
          { path: "nope", value: 1 },
        ],
      },
      at,
    );
    expect(events).toHaveLength(2);
    const call = { tool: "stripe", operation: "refund", values: null };
    const run = { run: "r", step: null, events };
    expect(
      limitState(refunds, { run, call, now, authority: "local" }),
    ).toMatchObject({
      used: 60,
      unread: 1,
      state: "unknown",
    });
    const input = {
      ...refunds,
      measure: { ...refunds.measure, path: "input.amount" },
      source: "admission" as const,
      label: "enforced-allowance" as const,
    };
    expect(
      limitState(input, {
        run,
        call: { ...call, values: { input: { amount: "1" } } },
        now,
        authority: "local",
      })?.state,
    ).toBe("unknown");
    expect(
      limitState(input, { run: null, call, now, authority: "local" })?.state,
    ).toBe("no_run");
    // Another agent's budget doesn't cover the main agent.
    expect(
      limitState(
        { ...input, agent: "dev" },
        { run, call, now, authority: "local" },
      ),
    ).toBeNull();
  });
});

describe(
  "what a changed budget or evidence requirement does",
  { timeout: GIT_TESTS },
  () => {
    const budgetOf = (text: string) => {
      const document = documentOf(text);
      if (document.version === 4 && document.limits[0])
        return document.limits[0];
      if (document.version !== 1 && document.budgets[0])
        return document.budgets[0];
      throw new Error("no budget");
    };
    const gateOf = (text: string) => {
      const document = documentOf(text);
      if (document.version === 1) throw new Error("no gate");
      return evidenceOf(document.gates[0]!);
    };
    const shown = (aspects: { impact: string | null; text: string }[]) =>
      aspects.map((aspect) => `${aspect.impact}: ${aspect.text}`);
    const impacts = (before: string, after: string) =>
      before.includes("- gate:")
        ? shown(evidenceAspects(gateOf(before), gateOf(after)))
        : shown(budgetAspects(budgetOf(before), budgetOf(after)));

    test("limit, window, reach and source", () => {
      expect(
        impacts(BUDGET, BUDGET.replace("limit: 3", "limit: 5")).join("\n"),
      ).toContain("loosened: limit 3 outbox.publish calls per run");
      expect(
        impacts(
          BUDGET,
          BUDGET.replace(
            "per: run",
            "per: day\n  timezone: Europe/Madrid\n  across: environment",
          ),
        ).join("\n"),
      ).toMatch(/changed: limit[\s\S]*tightened: across run → environment/);
      expect(
        impacts(BUDGET, BUDGET.replace("per: run", "per: step")).join("\n"),
      ).toContain("loosened");
      const tokens = `- required_engine_version: 5
- budget: Publications
  id: publications
  tokens: 3
  source: measured
  per: run
  otherwise: deny
`;
      expect(impacts(BUDGET, tokens).join("\n")).toContain(
        "loosened: source Enforced allowance → Measured usage · stops further work",
      );
      const legacy = `- required_engine_version: 5
- budget: Publications
  id: publications
  tokens: 3
  per: run
  otherwise: deny
  step_agent: dev
`;
      const all = impacts(tokens, legacy).join("\n");
      expect(all).toContain("Agent-reported usage");
      expect(all).toContain("loosened: agent all → dev");
      const [added] = permissionChanges(null, documentOf(BUDGET));
      expect(added).toMatchObject({ entry: "budget", impact: "tightened" });
      expect(added?.summary).toContain(
        "added: deny over 3 outbox.publish calls per run",
      );
    });

    test("evidence requirements added, removed, weakened", () => {
      const shapes = `- required_engine_version: 5
- contracts:
    shapes:
      r: { properties: { status: { values: [passed, failed] } } }
    evidence:
      ci: { shape: r, producers: [{ class: runtime-observed }, { class: externally-verified, verifier: gh }], subject: revision }
      qa: { shape: r, producers: [{ class: runtime-observed }], subject: revision }
- rule: Push
  command: { prefix: git push }
  effect: allow
`;
      const gate = (requires: string) =>
        `${shapes}- gate: G\n  id: g\n  command: { prefix: git push }\n  requires:\n${requires}  otherwise: deny\n`;
      const ci = (authority: string, where = "") =>
        `    - { evidence: ci, authority: ${authority}, subject: revision${where} }\n`;
      const qa =
        "    - { evidence: qa, authority: runtime-observed, subject: revision }\n";
      const all = impacts(
        gate(ci("externally-verified")),
        gate(ci("runtime-observed", ", where: { status: passed }") + qa),
      ).join("\n");
      expect(all).toContain(
        "loosened: ci authority externally-verified → runtime-observed",
      );
      expect(all).toContain("changed: ci conditions or contract changed");
      expect(all).toContain("tightened: now needs qa (runtime-observed)");
      expect(
        impacts(
          gate(ci("runtime-observed") + qa),
          gate(ci("runtime-observed")),
        ).join("\n"),
      ).toContain("loosened: no longer needs qa");
    });
  },
);

describe("the run listing", { timeout: GIT_TESTS }, () => {
  test("shows reservations, settlements and measurements", async () => {
    const repo = scratchRepo(
      BUDGET.replace(
        "- budget",
        "- rule: P\n  tool: outbox\n  operation: publish\n  resource: { kind: mcp_tool, match: any }\n  effect: allow\n- budget",
      ),
      "nodrail-listing-",
      "work",
    );
    process.env.NODRAIL_RUN = "listing";
    process.env.NODRAIL_LEDGER = mkdtempSync(join(tmpdir(), "nodrail-ledger-"));
    try {
      const event = (name: string) =>
        JSON.stringify({
          hook_event_name: name,
          session_id: "s",
          cwd: repo.repo,
          tool_name: "mcp__outbox__publish",
          tool_input: {},
          tool_use_id: "l1",
          tool_response: {},
        });
      await cli(["hook", repo.file], event("PreToolUse"));
      await cli(["hook", repo.file], event("PostToolUseFailure"));
      const shown = await cli(["runs", "show", "listing"], "");
      const text = shown.stdout + shown.stderr;
      expect(text).toContain("budget publications reserved 1 calls");
      expect(text).toContain(
        "budget reservation claude-code:l1 unknown (by runtime)",
      );
    } finally {
      delete process.env.NODRAIL_RUN;
      delete process.env.NODRAIL_LEDGER;
    }
  });
});
