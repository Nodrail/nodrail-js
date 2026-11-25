// Engine level 5 / document version 4:
// evidence requirements and numeric budgets, from the rule file to the
// hook's ledger. Version refusals, calendar windows, reserve and settle,
// idempotent re-deliveries, unknown outcomes, and 20 processes racing a
// budget's last slot.
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import {
  limitState,
  mediatedSettlement,
  reservationsFor,
  settle,
} from "../src/budget-ledger";
import { dayWindow, isTimeZone, localDate } from "../src/budget-windows";
import { readRun } from "../src/ledger";
import { policyDocument, type NumericBudget } from "../src/policies";
import type { RunContext, RunEvent } from "../src/runs";
import { compilePolicies } from "../src/yaml";
import { cli } from "./run-cli.ts";
import { hookAnswer, scratchRepo } from "./support/hook-answers.ts";

const compile = (text: string) =>
  compilePolicies([{ name: "rules.yaml", text }]);
const issues = (text: string) => {
  const result = compile(text);
  return result.ok ? [] : result.issues.map((issue) => issue.message);
};
const documentOf = (text: string) => {
  const result = compile(text);
  if (!result.ok)
    throw new Error(result.issues.map((i) => i.message).join("\n"));
  return result.document;
};

const OUTBOX = `- required_engine_version: 5
- rule: Publish
  tool: outbox
  operation: publish
  resource: { kind: mcp_tool, match: any }
  effect: allow
- budget: Publications per run
  id: publications
  count: { tool: outbox, operation: publish }
  limit: 3
  per: run
  otherwise: deny
`;

const REFUNDS = `- required_engine_version: 5
- contracts:
    shapes:
      refund-args:
        properties:
          amount: { type: integer, min: 1, unit: usd_cents }
          currency: { values: [usd, eur] }
    connections:
      stripe:
        operations:
          refund: { input: refund-args }
- rule: Refunds
  tool: stripe
  operation: refund
  resource: { kind: mcp_tool, match: any }
  effect: allow
- budget: Refunds per run
  id: refunds-per-run
  sum: { tool: stripe, operation: refund, path: input.amount }
  unit: usd_cents
  limit: 20000
  per: run
  otherwise: deny
`;

const EVIDENCE = (
  where = "{ status: passed }",
  authority = "runtime-observed",
) => `- required_engine_version: 5
- contracts:
    shapes:
      ci-result:
        properties:
          status: { values: [passed, failed], report: true }
          token: { type: string, max: 64, classification: secret, optional: true }
    evidence:
      ci-tests:
        shape: ci-result
        producers:
          - { class: runtime-observed }
          - { class: externally-verified, verifier: github-actions }
        subject: revision
- rule: Push
  command: { prefix: git push }
  effect: allow
- gate: Tested before a push
  id: tested
  command: { prefix: git push }
  requires:
    - { evidence: ci-tests, authority: ${authority}, subject: revision, where: ${where} }
  otherwise: deny
`;

describe("engine level 5 and document version 4", () => {
  test("a numeric budget compiles to a version 4 document, labelled by its source", () => {
    const document = documentOf(OUTBOX);
    expect(document.version).toBe(4);
    if (document.version !== 4) return;
    expect(document.budgets).toEqual([]);
    expect(document.limits).toEqual([
      {
        id: "publications",
        name: "Publications per run",
        agent: null,
        measure: { kind: "count", tool: "outbox", operation: "publish" },
        unit: "calls",
        source: "admission",
        label: "enforced-allowance",
        limit: 3,
        per: "run",
        timezone: null,
        across: "run",
        effect: "deny",
      },
    ]);
  });

  test("a sum of an input is admission; of a result, measured; measured tokens, measured", () => {
    const refunds = documentOf(REFUNDS);
    if (refunds.version !== 4) throw new Error("expected version 4");
    expect(refunds.limits[0]).toMatchObject({
      source: "admission",
      label: "enforced-allowance",
      unit: "usd_cents",
    });
    const tokens = documentOf(`- required_engine_version: 5
- budget: Subagent tokens
  tokens: 100000
  source: measured
  per: run
  otherwise: deny
`);
    if (tokens.version !== 4) throw new Error("expected version 4");
    expect(tokens.limits[0]).toMatchObject({
      measure: { kind: "tokens" },
      unit: "tokens",
      source: "measured",
      label: "measured-usage",
      limit: 100000,
    });
  });

  test("files without level 5 features compile exactly as before", () => {
    const document = documentOf(`- required_engine_version: 5
- budget: Calls
  per: run
  tool_calls: 10
  otherwise: deny
`);
    expect(document.version).toBe(2);
  });

  test.each([
    [
      "a numeric budget in a level 4 file",
      OUTBOX.replace(
        "required_engine_version: 5",
        "required_engine_version: 4",
      ),
      "numeric budgets need required_engine_version: 5",
    ],
    [
      "an evidence requirement in a level 4 file",
      EVIDENCE().replace(
        "required_engine_version: 5",
        "required_engine_version: 4",
      ),
      "need required_engine_version: 5",
    ],
    [
      "a day without its timezone",
      OUTBOX.replace("per: run", "per: day\n  across: run"),
      "per: day needs timezone",
    ],
    [
      "a timezone that isn't IANA",
      OUTBOX.replace(
        "per: run",
        "per: day\n  timezone: Mars/Olympus\n  across: run",
      ),
      "isn't an IANA timezone",
    ],
    [
      "a day without across",
      OUTBOX.replace("per: run", "per: day\n  timezone: Europe/Madrid"),
      "per: day needs across",
    ],
    [
      "a timezone on a run",
      OUTBOX.replace("per: run", "per: run\n  timezone: Europe/Madrid"),
      "Only per: day has a timezone",
    ],
    [
      "a step shared across the environment",
      OUTBOX.replace("per: run", "per: step\n  across: environment"),
      "A step is one machine's",
    ],
    [
      "two measures in one budget",
      OUTBOX.replace("  limit: 3", "  tokens: 5\n  limit: 3"),
      "counts one thing",
    ],
    [
      "measured tokens with a separate limit",
      `- required_engine_version: 5
- budget: T
  tokens: 5
  source: measured
  limit: 3
  per: run
  otherwise: deny
`,
      "drop limit",
    ],
    [
      "a fractional limit",
      OUTBOX.replace("limit: 3", "limit: 2.5"),
      "whole number",
    ],
    [
      "a sum without contracts",
      `- required_engine_version: 5
- budget: S
  sum: { tool: stripe, operation: refund, path: input.amount }
  unit: usd_cents
  limit: 10
  per: run
  otherwise: deny
`,
      "declare it in a contracts entry",
    ],
    [
      "a sum in another unit than its property",
      REFUNDS.replace(
        "  unit: usd_cents\n  limit",
        "  unit: eur_cents\n  limit",
      ),
      "The budget's unit must equal the property's",
    ],
    [
      "an evidence requirement without subject: revision",
      EVIDENCE().replace(", subject: revision, where", ", where"),
      "subject: revision",
    ],
    [
      "an evidence where on a secret path",
      EVIDENCE("{ token: abc }"),
      "token is secret",
    ],
  ])("%s is refused", (_name, text, message) => {
    expect(issues(text).join("\n")).toContain(message);
  });

  test("an evidence requirement compiles into the gate, pinned to the evidence contract", () => {
    const document = documentOf(EVIDENCE());
    if (document.version !== 4) throw new Error("expected version 4");
    const [gate] = document.gates;
    expect(gate?.requires).toEqual([]);
    expect(gate && "evidence" in gate && gate.evidence).toEqual([
      {
        evidence: "ci-tests",
        contract: document.evidence["ci-tests"]!.contract,
        where: [{ path: ["status"], op: "eq", value: "passed" }],
        authority: "runtime-observed",
        subject: "revision",
      },
    ]);
    expect(document.evidence["ci-tests"]!.producers).toEqual([
      { class: "runtime-observed", verifier: null },
      { class: "externally-verified", verifier: "github-actions" },
    ]);
  });

  test("a version 3 reader refuses version 4, and version 4 is checked in full", () => {
    const document = documentOf(OUTBOX);
    // Relabelled as 3, its numeric budgets are keys version 3 doesn't know.
    expect(policyDocument.safeParse({ ...document, version: 3 }).success).toBe(
      false,
    );
    const withoutLimits = { ...document, limits: undefined };
    expect(policyDocument.safeParse(withoutLimits).success).toBe(false);
    // A label can't claim more than the source gives.
    const measured = structuredClone(document) as { limits: NumericBudget[] };
    measured.limits[0]!.label = "measured-usage";
    expect(policyDocument.safeParse(measured).success).toBe(false);
  });

  test("an engine at level 4 refuses a level 5 file: the file's level is above its own", () => {
    // Every engine compares a file's required_engine_version with its own;
    // this one is 5, so a file asking for 6 is refused the same way 4 refuses 5.
    expect(issues("- required_engine_version: 6\n")).toEqual([
      "This file needs engine version 6; this is 5.",
    ]);
  });
});

describe("calendar windows", () => {
  test("a day is 23 hours when the clocks go forward and 25 when they go back", () => {
    const spring = dayWindow(new Date("2026-03-29T12:00:00Z"), "Europe/Madrid");
    expect(spring.key).toBe("2026-03-29");
    expect(spring.start.toISOString()).toBe("2026-03-28T23:00:00.000Z");
    expect(spring.end.toISOString()).toBe("2026-03-29T22:00:00.000Z");
    expect(spring.end.getTime() - spring.start.getTime()).toBe(23 * 3_600_000);
    const autumn = dayWindow(new Date("2026-10-25T12:00:00Z"), "Europe/Madrid");
    expect(autumn.end.getTime() - autumn.start.getTime()).toBe(25 * 3_600_000);
  });

  test("the local date decides the window, not UTC's", () => {
    // 23:30 UTC on the 21st is already the 22nd in Madrid, still the 21st in New York.
    const at = new Date("2026-11-21T23:30:00Z");
    expect(localDate(at, "Europe/Madrid")).toBe("2026-11-22");
    expect(localDate(at, "America/New_York")).toBe("2026-11-21");
    expect(dayWindow(at, "UTC").key).toBe("2026-11-21");
  });

  test("a zone whose clocks skip midnight still has a start", () => {
    // Santiago moves from 00:00 to 01:00 on 2026-09-06.
    const day = dayWindow(new Date("2026-09-06T12:00:00Z"), "America/Santiago");
    expect(localDate(day.start, "America/Santiago")).toBe("2026-09-06");
    expect(
      localDate(new Date(day.start.getTime() - 1), "America/Santiago"),
    ).toBe("2026-09-05");
  });

  test("only IANA names are time zones", () => {
    expect(isTimeZone("Europe/Madrid")).toBe(true);
    expect(isTimeZone("UTC")).toBe(true);
    expect(isTimeZone("Mars/Olympus")).toBe(false);
    expect(isTimeZone("")).toBe(false);
  });

  test("a day budget counts only today's calls", () => {
    const budget = {
      ...(documentOf(OUTBOX) as { limits: NumericBudget[] }).limits[0]!,
      per: "day" as const,
      timezone: "Europe/Madrid",
    };
    const reserved = (at: string, key: string): RunEvent => ({
      type: "budget.reserved",
      step: null,
      agent: "main",
      at,
      key,
      budget: budget.id,
      amount: 1,
      unit: "calls",
      tool: "outbox",
      operation: "publish",
      input_sha256: null,
    });
    const run: RunContext = {
      run: "r",
      step: null,
      events: [
        reserved("2026-11-20T22:59:00Z", "claude-code:a"), // the 20th in Madrid
        reserved("2026-11-20T23:01:00Z", "claude-code:b"), // the 21st
      ],
    };
    const state = limitState(budget, {
      run,
      call: { tool: "outbox", operation: "publish", values: null },
      now: new Date("2026-11-21T12:00:00Z"),
      authority: "local",
    });
    expect(state).toMatchObject({
      used: 1,
      state: "ok",
      resets: "2026-11-21T23:00:00.000Z",
    });
  });
});

const outbox = documentOf(OUTBOX) as { limits: NumericBudget[] };
const [publications] = outbox.limits as [NumericBudget];
const now = new Date("2026-11-21T12:00:00Z");
const call = { tool: "outbox", operation: "publish", values: null };
const at = now.toISOString();

function reserveIn(events: RunEvent[], key: string) {
  const state = limitState(publications, {
    run: { run: "r", step: null, events },
    call,
    now,
    authority: "local",
  })!;
  return reservationsFor([state], [publications], {
    key,
    ...call,
    step: null,
    agent: "main",
    at,
    input_sha256: "sha256:" + "a".repeat(64),
  });
}

describe("reserve and settle", () => {
  test("reserved, consumed and unknown all count; only released frees", () => {
    let events: RunEvent[] = [];
    for (const key of ["h:1", "h:2", "h:3"])
      events = [...events, ...reserveIn(events, key)];
    expect(reserveIn(events, "h:4")).toEqual([]);
    events.push(settle(events, "h:1", "consumed", at)!);
    events.push(settle(events, "h:2", "unknown", at)!);
    expect(reserveIn(events, "h:4")).toEqual([]);
    events.push(settle(events, "h:3", "released", at)!);
    expect(reserveIn(events, "h:4")).toHaveLength(1);
  });

  test("a repeated settlement changes nothing; a person's reconcile replaces the runtime's", async () => {
    const events = reserveIn([], "h:1");
    const first = settle(events, "h:1", "unknown", at)!;
    expect(settle([...events, first], "h:1", "consumed", at)).toBeNull();
    const { reconcile, settlements } = await import("../src/budget-ledger");
    const person = reconcile([...events, first], "h:1", {
      state: "released",
      at,
      note: "checked the outbox",
    })!;
    expect(settlements([...events, first, person])("h:1")).toBe("released");
  });

  test("a mediated call releases only when it failed or never reached the provider", () => {
    const digest = "sha256:" + "a".repeat(64);
    const settled = (
      execution: "succeeded" | "failed" | "not-called" | "unknown",
    ) => {
      const events = reserveIn([], "claude-code:t1");
      const settlement = {
        succeeded: "consumed",
        failed: "released",
        "not-called": "released",
        unknown: "unknown",
      } as const;
      return mediatedSettlement(
        events,
        {
          event: randomUUID(),
          connection: "outbox",
          operation: "publish",
          input_sha256: digest,
          settlement: settlement[execution],
          measured: [],
        },
        at,
      );
    };
    expect(settled("succeeded")).toMatchObject([
      { state: "consumed", key: "claude-code:t1" },
    ]);
    expect(settled("failed")).toMatchObject([{ state: "released" }]);
    expect(settled("not-called")).toMatchObject([{ state: "released" }]);
    expect(settled("unknown")).toMatchObject([{ state: "unknown" }]);
  });

  test("an agent's receipt saying usage 0 never lowers a trusted total", () => {
    const events: RunEvent[] = [
      ...reserveIn([], "h:1"),
      ...reserveIn(reserveIn([], "h:1"), "h:2"),
    ].filter(
      (e, i, all) =>
        all.findIndex(
          (x) =>
            x.type === e.type && "key" in x && "key" in e && x.key === e.key,
        ) === i,
    );
    const before = limitState(publications, {
      run: { run: "r", step: null, events },
      call,
      now,
      authority: "local",
    })!;
    const claimed: RunEvent[] = [
      ...events,
      { type: "step.started", step: "s", agent: "dev", at },
      {
        type: "step.finished",
        step: "s",
        agent: "dev",
        at,
        verdict: "done",
        findings: [],
        usage: { tokens: 0, usd: 0 },
      },
    ];
    const after = limitState(publications, {
      run: { run: "r", step: null, events: claimed },
      call,
      now,
      authority: "local",
    })!;
    expect(before.used).toBe(2);
    expect(after.used).toBe(before.used);
  });

  test("measured tokens: a step without a reading is unknown, and unknown holds", () => {
    const tokens = (
      documentOf(`- required_engine_version: 5
- budget: Subagent tokens
  tokens: 1000
  source: measured
  per: run
  otherwise: deny
`) as { limits: NumericBudget[] }
    ).limits[0]!;
    const measured = (amount: number | null, key: string): RunEvent => ({
      type: "budget.measured",
      step: null,
      agent: "main",
      at,
      key,
      tool: "claude-code",
      operation: "agent",
      path: "tokens",
      amount,
    });
    const dispatch = { tool: "claude-code", operation: "agent", values: null };
    const state = (events: RunEvent[]) =>
      limitState(tokens, {
        run: { run: "r", step: null, events },
        call: dispatch,
        now,
        authority: "local",
      })!;
    expect(state([measured(400, "h:1")]).state).toBe("ok");
    const unknown = state([measured(400, "h:1"), measured(null, "h:2")]);
    expect(unknown).toMatchObject({ state: "unknown", used: 400, unread: 1 });
    expect(state([measured(600, "h:1"), measured(400, "h:2")]).state).toBe(
      "over",
    );
  });

  test("a shared budget holds in local mode, and an uncounted one holds anywhere", () => {
    const shared = { ...publications, across: "environment" as const };
    expect(
      limitState(shared, {
        run: { run: "r", step: null, events: [] },
        call,
        now,
        authority: "local",
      })?.state,
    ).toBe("shared");
    expect(
      limitState(publications, {
        run: { run: "r", step: null, events: [] },
        call,
        now,
        authority: null,
      })?.state,
    ).toBe("uncounted");
  });
});

// Through the real hook, in a scratch repository.
type Repo = { repo: string; file: string };
const ledgerOf = ({ repo }: Repo) => join(repo, ".git", "nodrail", "runs");
const RUN = "accountable-run";

function preToolUse(
  repo: Repo,
  tool: string,
  input: object,
  id: string = randomUUID(),
) {
  return JSON.stringify({
    hook_event_name: "PreToolUse",
    session_id: "s-1",
    cwd: repo.repo,
    tool_name: tool,
    tool_input: input,
    tool_use_id: id,
  });
}

async function send(repo: Repo, event: string) {
  process.env.NODRAIL_RUN = RUN;
  try {
    const result = await cli(["hook", repo.file], event);
    return { ...result, answer: hookAnswer(result.stdout) };
  } finally {
    delete process.env.NODRAIL_RUN;
  }
}

const events = (repo: Repo) => readRun(ledgerOf(repo), RUN);

/** One outbox publication through the hook; its decision. */
const publish = async (repo: Repo, n: number, id?: string) =>
  (await send(repo, preToolUse(repo, "mcp__outbox__publish", { n }, id)))
    .answer;

describe("the hook reserves and settles", () => {
  test("three publications go ahead, the fourth is held before the provider", async () => {
    const repo = scratchRepo(OUTBOX, "nodrail-outbox-", "work");
    for (let index = 0; index < 3; index += 1)
      expect((await publish(repo, index)).permissionDecision).toBe("allow");
    const fourth = await publish(repo, 4);
    expect(fourth.permissionDecision).toBe("deny");
    expect(fourth.permissionDecisionReason).toContain(
      "Budget publications is at 3 of 3 calls (enforced allowance)",
    );
    expect(
      events(repo).filter((e) => e.type === "budget.reserved"),
    ).toHaveLength(3);
  });

  test("a PreToolUse delivered twice gets the same decision and reserves once", async () => {
    const repo = scratchRepo(
      OUTBOX.replace("limit: 3", "limit: 1"),
      "nodrail-twice-",
      "work",
    );
    const event = preToolUse(
      repo,
      "mcp__outbox__publish",
      { n: 1 },
      "toolu_same",
    );
    expect((await send(repo, event)).answer.permissionDecision).toBe("allow");
    // The last slot is this call's own: the repeat is still allowed.
    expect((await send(repo, event)).answer.permissionDecision).toBe("allow");
    const recorded = events(repo);
    expect(recorded.filter((e) => e.type === "budget.reserved")).toHaveLength(
      1,
    );
    expect(recorded.filter((e) => e.type === "action")).toHaveLength(1);
    expect((await publish(repo, 2)).permissionDecision).toBe("deny");
  });

  test("a call with no Post stays counted; PostToolUse consumes; a failure without a mediated record is unknown", async () => {
    const repo = scratchRepo(OUTBOX, "nodrail-post-", "work");
    const post = (id: string, name = "PostToolUse") =>
      JSON.stringify({
        hook_event_name: name,
        session_id: "s-1",
        cwd: repo.repo,
        tool_name: "mcp__outbox__publish",
        tool_input: {},
        tool_use_id: id,
        tool_response: {},
      });
    for (const n of [1, 2, 3]) await publish(repo, n, `t${n}`);
    expect((await send(repo, post("t1"))).code).toBe(0);
    expect((await send(repo, post("t2", "PostToolUseFailure"))).stdout).toBe(
      "",
    );
    // A repeated Post settles nothing more.
    await send(repo, post("t1"));
    const settled = events(repo).filter((e) => e.type === "budget.settled");
    expect(settled).toMatchObject([
      { key: "claude-code:t1", state: "consumed" },
      { key: "claude-code:t2", state: "unknown" },
    ]);
    // t3 never got a Post (a declined prompt, a crash): still counted.
    const fourth = await publish(repo, 4);
    expect(fourth.permissionDecision).toBe("deny");
    expect(fourth.permissionDecisionReason).toContain("1 unknown");
  });

  test("a subagent's measured tokens are recorded; a background one with none is unknown and holds", async () => {
    const repo = scratchRepo(
      `- required_engine_version: 5
- rule: Start agents
  tool: claude-code
  operation: agent
  resource: { kind: agent, match: any }
  effect: allow
- budget: Subagent tokens
  id: subagent-tokens
  tokens: 1000
  source: measured
  per: run
  otherwise: deny
`,
      "nodrail-tokens-",
      "work",
    );
    const dispatch = (id: string) =>
      preToolUse(
        repo,
        "Agent",
        { subagent_type: "dev", description: "d", prompt: "go" },
        id,
      );
    const post = (id: string, response: object) =>
      JSON.stringify({
        hook_event_name: "PostToolUse",
        session_id: "s-1",
        cwd: repo.repo,
        tool_name: "Agent",
        tool_input: {},
        tool_use_id: id,
        tool_response: response,
      });
    expect((await send(repo, dispatch("a1"))).answer.permissionDecision).toBe(
      "allow",
    );
    await send(repo, post("a1", { totalTokens: 300 }));
    expect((await send(repo, dispatch("a2"))).answer.permissionDecision).toBe(
      "allow",
    );
    await send(repo, post("a2", { status: "async_launched" }));
    const held = await send(repo, dispatch("a3"));
    expect(held.answer.permissionDecision).toBe("deny");
    expect(held.answer.permissionDecisionReason).toContain(
      "≥ 300 of 1000 tokens, 1 step unknown",
    );
  });
});

describe("evidence requirements in the hook", () => {
  async function recordCi(repo: Repo, status: string, contract?: string) {
    const { recordEvidence } = await import("../src/evidence");
    const { workRevision } = await import("../src/revision");
    const document = documentOf(readFileSync(repo.file, "utf8"));
    if (document.version !== 4) throw new Error("expected version 4");
    const subject = workRevision(repo.repo);
    recordEvidence(ledgerOf(repo).replace(/runs$/, "runs"), {
      type: "evidence.recorded",
      event: randomUUID(),
      evidence: "ci-tests",
      contract: contract ?? document.evidence["ci-tests"]!.contract,
      projection: "sha256:" + "b".repeat(64),
      producer: { class: "runtime-observed", id: "cli:evidence-run" },
      subject: subject ? { kind: "revision", digest: subject } : null,
      observed: { exit_code: 0, started_at: at, finished_at: at },
      validation: { state: "valid", issues: [] },
      value: { status },
    });
  }

  const push = (repo: Repo) =>
    send(repo, preToolUse(repo, "Bash", { command: "git push" }));

  function committed() {
    const repo = scratchRepo(EVIDENCE(), "nodrail-evidence-", "work");
    for (const args of [
      ["config", "user.email", "t@example.com"],
      ["config", "user.name", "T"],
      ["config", "commit.gpgsign", "false"],
      ["add", "rules.yaml"],
      ["commit", "-q", "-m", "one"],
    ])
      spawnGit(repo.repo, args);
    return repo;
  }

  test("evidence for the current revision opens the gate; a replay of an old subject never does", async () => {
    const repo = committed();
    expect((await push(repo)).answer.permissionDecisionReason).toContain(
      "no ci-tests for this revision",
    );
    await recordCi(repo, "passed");
    expect((await push(repo)).answer.permissionDecision).toBe("allow");
    // The work changes: the old event is about another revision.
    spawnGit(repo.repo, ["commit", "-q", "--allow-empty", "-m", "two"]);
    const held = await push(repo);
    expect(held.answer.permissionDecision).toBe("deny");
    expect(held.answer.permissionDecisionReason).toContain("the latest is for");
    // Copying the old line again changes nothing: it is still about the old subject.
    const file = join(ledgerOf(repo), "evidence", "ci-tests.jsonl");
    const line = readFileSync(file, "utf8").split("\n")[0]!;
    const { appendFileSync } = await import("node:fs");
    appendFileSync(
      file,
      `${line.replace(/"event":"[^"]+"/, `"event":"${randomUUID()}"`)}\n`,
    );
    expect((await push(repo)).answer.permissionDecision).toBe("deny");
  });

  test("a failed result, or one validated against another contract, says so", async () => {
    const repo = committed();
    await recordCi(repo, "failed");
    expect((await push(repo)).answer.permissionDecisionReason).toContain(
      "doesn't meet the where conditions",
    );
    await recordCi(repo, "passed", "sha256:" + "c".repeat(64));
    expect((await push(repo)).answer.permissionDecisionReason).toContain(
      "validated against another revision of its contract; run the producer again under the published contract",
    );
  });

  test("externally verified evidence can't be met here without Cloud", async () => {
    const repo = scratchRepo(
      EVIDENCE(undefined, "externally-verified"),
      "nodrail-verified-",
      "work",
    );
    spawnGit(repo.repo, [
      "-c",
      "user.email=t@e",
      "-c",
      "user.name=T",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "one",
    ]);
    await recordCi(repo, "passed");
    const held = await push(repo);
    expect(held.answer.permissionDecision).toBe("deny");
    expect(held.answer.permissionDecisionReason).toContain(
      "only Cloud can confirm",
    );
  });
});

describe("Cloud's answer for externally verified evidence", () => {
  test("revoked and contract-mismatch answers are explained; failures are unmet", async () => {
    const { evidenceShortfall } = await import("../src/run-evidence");
    const { fetchEvidenceStatus } = await import("../src/evidence-remote");
    const need = {
      evidence: "ci-tests",
      contract: "sha256:" + "a".repeat(64),
      where: [],
      authority: "externally-verified" as const,
      subject: "revision" as const,
    };
    const answer = (status: object) => ({
      subject: "sha256:" + "d".repeat(64),
      evidence: {
        local: () => [],
        remote: () =>
          ({
            met: false,
            event_id: null,
            verifier: { name: "github-actions", revoked_at: null },
            received_at: null,
            ...status,
          }) as never,
      },
    });
    expect(
      evidenceShortfall(
        need,
        { gate: "g", index: 0 },
        answer({
          reason_code: "verifier_revoked",
          verifier: {
            name: "github-actions",
            revoked_at: "2026-11-20T10:00:00Z",
          },
        }),
      ),
    ).toBe(
      "the verifier github-actions was revoked on 2026-11-20; its evidence no longer counts",
    );
    expect(
      evidenceShortfall(
        need,
        { gate: "g", index: 0 },
        answer({ reason_code: "contract_mismatch" }),
      ),
    ).toContain("another revision of its contract");
    const config = (respond: () => Promise<Response>) => ({
      url: "https://nodrail.example",
      token: "t",
      workspaceRevision: "rev",
      fetch: (async () => respond()) as typeof fetch,
    });
    const ask = { gate: "g", index: 0, subject: "sha256:x" };
    expect(
      (
        await fetchEvidenceStatus(
          config(async () => new Response("", { status: 404 })),
          ask,
        )
      ).reason_code,
    ).toBe("unpublished");
    expect(
      (
        await fetchEvidenceStatus(
          config(async () => new Response("", { status: 403 })),
          ask,
        )
      ).reason_code,
    ).toBe("unauthorized");
    expect(
      (
        await fetchEvidenceStatus(
          config(async () => {
            throw new Error("down");
          }),
          ask,
        )
      ).reason_code,
    ).toBe("offline");
    expect(
      (
        await fetchEvidenceStatus(
          {
            ...config(async () => new Response("{}")),
            url: "http://nodrail.example",
          },
          ask,
        )
      ).reason_code,
    ).toBe("offline");
  });
});

// 20 hook processes at once, each its own `node`, as hosts run them.
const engineCli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
// Resolved here: the scratch repository has no node_modules of its own.
const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;

/** One hook process's answer; a process that failed to answer fails the test. */
function hookProcess(repo: Repo, event: string) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", tsx, engineCli, "hook", repo.file],
      { cwd: repo.repo, env: { ...process.env, NODRAIL_RUN: RUN } },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += String(chunk)));
    child.stderr.on("data", (chunk) => (err += String(chunk)));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(out)
        : reject(new Error(`hook exited ${code}: ${err}`)),
    );
    child.stdin.end(event);
  });
}

describe("20 processes race the last slot", () => {
  test("count: exactly one of them gets it", async () => {
    const repo = scratchRepo(OUTBOX, "nodrail-race-count-", "work");
    await send(repo, preToolUse(repo, "mcp__outbox__publish", { n: 1 }));
    await send(repo, preToolUse(repo, "mcp__outbox__publish", { n: 2 }));
    const answers = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        hookProcess(
          repo,
          preToolUse(repo, "mcp__outbox__publish", { n: 10 + index }),
        ),
      ),
    );
    const allowed = answers.filter(
      (out) => hookAnswer(out).permissionDecision === "allow",
    );
    expect(allowed).toHaveLength(1);
    expect(
      events(repo).filter((e) => e.type === "budget.reserved"),
    ).toHaveLength(3);
  }, 120_000);

  test("sum: the total never passes the limit", async () => {
    const repo = scratchRepo(REFUNDS, "nodrail-race-sum-", "work");
    const refund = (amount: number) =>
      preToolUse(repo, "mcp__stripe__refund", { amount, currency: "usd" });
    for (const amount of [5000, 5000, 5000])
      expect((await send(repo, refund(amount))).answer.permissionDecision).toBe(
        "allow",
      );
    const answers = await Promise.all(
      Array.from({ length: 20 }, () => hookProcess(repo, refund(5000))),
    );
    expect(
      answers.filter((out) => hookAnswer(out).permissionDecision === "allow"),
    ).toHaveLength(1);
    const total = events(repo)
      .filter((e) => e.type === "budget.reserved")
      .reduce(
        (sum, e) => sum + (e.type === "budget.reserved" ? e.amount : 0),
        0,
      );
    expect(total).toBe(20000);
  }, 120_000);
});

function spawnGit(cwd: string, args: string[]) {
  spawnSync("git", args, { cwd });
}

describe("what connectors and Copilot plug in", () => {
  test("a mediated call settles its reservation through ./ledger, joined by input digest", async () => {
    const ledger = await import("../src/run-ledger");
    const { fingerprint } = await import("../src/protocol");
    const repo = scratchRepo(OUTBOX, "nodrail-mediated-", "work");
    const input = { n: 1 };
    await send(repo, preToolUse(repo, "mcp__outbox__publish", input, "m1"));
    const directory = ledgerOf(repo);
    const call = {
      type: "connection.call" as const,
      event: randomUUID(),
      connection: "outbox",
      operation: "publish",
      occurred_at: at,
      producer: { class: "runtime-observed" as const, id: "connector:outbox" },
      input: null,
      input_sha256: fingerprint(input),
      execution: "failed" as const,
      result: null,
      delivered: false,
    };
    ledger.withRunLock(directory, RUN, () => {
      ledger.record(directory, RUN, {
        type: "connection.call",
        step: null,
        agent: "main",
        at,
        call,
      });
      ledger.settleMediatedCall(directory, RUN, {
        event: call.event,
        connection: "outbox",
        operation: "publish",
        input_sha256: call.input_sha256,
        settlement: "released",
        measured: [],
      });
    });
    expect(
      events(repo).filter((e) => e.type === "budget.settled"),
    ).toMatchObject([
      { key: "claude-code:m1", state: "released", by: "runtime" },
    ]);
    // The host's PostToolUseFailure that follows settles nothing more.
    await send(
      repo,
      JSON.stringify({
        hook_event_name: "PostToolUseFailure",
        session_id: "s-1",
        cwd: repo.repo,
        tool_name: "mcp__outbox__publish",
        tool_input: input,
        tool_use_id: "m1",
      }),
    );
    expect(
      events(repo).filter((e) => e.type === "budget.settled"),
    ).toHaveLength(1);
  });

  test("Copilot's postToolUse settles as Claude Code's PostToolUse; a patch's files get their own ids", async () => {
    const { copilotEvents, copilotSettleEvent } =
      await import("../src/copilot-hook");
    const post = (resultType: string) =>
      JSON.parse(
        copilotSettleEvent(
          JSON.stringify({
            toolCallId: "c1",
            toolName: "bash",
            toolArgs: {},
            cwd: "/w",
            toolResult: { resultType, textResultForLlm: "" },
          }),
        )!,
      ) as { hook_event_name: string; tool_use_id: string };
    expect(post("success")).toMatchObject({
      hook_event_name: "PostToolUse",
      tool_use_id: "c1",
    });
    expect(post("failure").hook_event_name).toBe("PostToolUseFailure");
    expect(
      copilotSettleEvent(
        JSON.stringify({ toolCallId: "c1", toolName: "bash", toolArgs: {} }),
      ),
    ).toBeNull();
    const patch =
      "*** Begin Patch\n*** Add File: a.txt\n+x\n*** Add File: b.txt\n+y\n*** End Patch\n";
    const events = copilotEvents(
      JSON.stringify({
        toolCallId: "p1",
        toolName: "apply_patch",
        toolArgs: { input: patch },
        cwd: "/w",
      }),
    );
    expect(
      Array.isArray(events) &&
        events.map(
          (e) => (JSON.parse(e) as { tool_use_id: string }).tool_use_id,
        ),
    ).toEqual(["p1#0", "p1#1"]);
  });
});

test("the level 5 rule files in docs/contracts.md compile to version 4", () => {
  const page = readFileSync(
    join(import.meta.dirname, "../docs/contracts.md"),
    "utf8",
  );
  const blocks = [
    ...page.matchAll(/^```yaml\n(- required_engine_version: 5[\s\S]*?)^```$/gm),
  ].map(([, body]) => body ?? "");
  expect(blocks).toHaveLength(2);
  for (const text of blocks) expect(documentOf(text).version).toBe(4);
});
