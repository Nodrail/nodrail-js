// Engine level 5 in the CLI (Wave 3, lane L): apply registers the hook on
// a call's outcome when the policy has numeric budgets, and writes the
// files the hooks read; plan refuses what a local setup can't enforce;
// `nodrail evidence` and `nodrail budgets`; and the outbox's three calls,
// the fourth held, end to end through the real `nodrail policy hook`.
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { readEvidence } from "@nodrail/policy-engine/ledger";
import { cleanRevision } from "@nodrail/policy-engine/revision";
import { SUBMIT_EXIT } from "../src/commands/evidence.ts";
import { CONTRACTS_FILE, EVIDENCE_FILE } from "../src/setup/accountable.ts";
import { codexHookCommand } from "../src/setup/codex.ts";
import { fakeIo } from "./support/fake-io.ts";
import {
  codexTools,
  locked,
  RESOURCES,
  windows,
} from "./support/setup-project.ts";

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

const SHARED = OUTBOX.replace(
  "per: run",
  "per: day\n  timezone: Europe/Madrid\n  across: environment",
);

const EVIDENCE = (producers: string) => `- required_engine_version: 5
- contracts:
    shapes:
      ci-result:
        properties:
          status: { values: [passed, failed], report: true }
          tests: { type: integer, min: 0, report: true }
    evidence:
      ci-tests:
        shape: ci-result
        producers: ${producers}
        subject: revision
- rule: Push
  command: { prefix: git push }
  effect: allow
- gate: Tested before a push
  id: tested
  command: { prefix: git push }
  requires:
    - { evidence: ci-tests, authority: runtime-observed, subject: revision, where: { status: passed } }
  otherwise: deny
`;

const LOCAL = EVIDENCE("[{ class: runtime-observed }]");
const VERIFIED = EVIDENCE(
  "[{ class: externally-verified, verifier: github-actions }]",
);

/** The release team with this policy as its only import. */
const withPolicy = (policy: string, runtime = "claude-code") => ({
  ...RESOURCES,
  "policies/base.yaml": policy,
  "nodrail.yaml": RESOURCES["nodrail.yaml"].replace("claude-code", runtime),
});

const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
};

/** A locked project in a git repository with one commit. */
async function repoProject(policy: string, runtime = "claude-code") {
  const p = await locked(
    withPolicy(policy, runtime),
    runtime === "codex" ? codexTools() : undefined,
  );
  git(p.cwd, "init", "-q", "-b", "main");
  git(p.cwd, "-c", "user.name=t", "-c", "user.email=t@t", "add", "-A");
  git(
    p.cwd,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-q",
    "-m",
    "one",
  );
  return p;
}

type Settings = {
  hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]>;
};

afterEach(() => {
  delete process.env.NODRAIL_RUN;
});

describe("apply registers the hook where budgets settle", () => {
  test("Claude Code: PostToolUse and PostToolUseFailure get the policy hook, without blocking", async () => {
    const p = await locked(withPolicy(OUTBOX));
    expect((await p.run("apply", "--yes")).code).toBe(0);
    const settings = JSON.parse(p.read(".claude/settings.json")) as Settings;
    const pre = settings.hooks.PreToolUse![0]!.hooks[0]!.command;
    for (const event of ["PostToolUse", "PostToolUseFailure"])
      expect(settings.hooks[event]).toEqual([
        { matcher: "*", hooks: [{ type: "command", command: pre }] },
      ]);
    // destroy takes them out with the rest: the file held only nodrail's.
    const destroyed = await p.run("destroy", "--yes");
    expect([destroyed.code, existsSync(join(p.cwd, ".claude"))]).toEqual([
      0,
      false,
    ]);
  });

  test("a policy without numeric budgets registers neither", async () => {
    const p = await locked();
    expect((await p.run("apply", "--yes")).code).toBe(0);
    const settings = JSON.parse(p.read(".claude/settings.json")) as Settings;
    expect(Object.keys(settings.hooks)).toEqual(["PreToolUse", "SessionStart"]);
    expect(existsSync(join(p.cwd, EVIDENCE_FILE))).toBe(false);
    expect(existsSync(join(p.cwd, CONTRACTS_FILE))).toBe(false);
  });

  test.skipIf(windows)(
    "Codex: PostToolUse gets the same hook command",
    async () => {
      const p = await locked(withPolicy(OUTBOX, "codex"), codexTools());
      const plan = p.plan();
      const hooks = JSON.parse(
        plan.files
          .find((file) => file.path === ".codex/hooks.json")!
          .content.toString("utf8"),
      ) as Settings;
      const command = codexHookCommand(p.cwd, "lead");
      expect(hooks.hooks.PreToolUse![0]!.hooks[0]!.command).toBe(command);
      expect(hooks.hooks.PostToolUse).toEqual([
        { matcher: ".*", hooks: [{ type: "command", command }] },
      ]);
      // Codex has no PostToolUseFailure.
      expect(hooks.hooks.PostToolUseFailure).toBeUndefined();
    },
  );

  test("Copilot: postToolUse, which carries success and failure", async () => {
    const p = await locked(withPolicy(OUTBOX, "copilot"));
    const hooks = JSON.parse(
      p
        .plan()
        .files.find((file) => file.path === ".github/hooks/nodrail.json")!
        .content.toString("utf8"),
    ) as { hooks: Record<string, { bash: string }[]> };
    expect(hooks.hooks.postToolUse![0]!.bash).toBe(
      hooks.hooks.preToolUse![0]!.bash,
    );
  });

  test("externally verified evidence: the hook gets --evidence and its file names the locked workspace revision", async () => {
    const p = await locked(withPolicy(VERIFIED));
    p.env.NODRAIL_URL = "https://nodrail.example";
    const plan = p.plan();
    const config = JSON.parse(
      plan.files
        .find((file) => file.path === EVIDENCE_FILE)!
        .content.toString("utf8"),
    ) as { url: string; workspace_revision: string };
    expect(config).toEqual({
      url: "https://nodrail.example",
      workspace_revision: plan.revision.workspace,
    });
    expect(config.workspace_revision).toMatch(/^[0-9a-f]{64}$/);
    const settings = plan.merged[".claude/settings.json"] as Settings;
    expect(settings.hooks.PreToolUse![0]!.hooks[0]!.command).toContain(
      ` --evidence "$CLAUDE_PROJECT_DIR/${EVIDENCE_FILE}" --agent lead`,
    );
    delete p.env.NODRAIL_URL;
  });

  test("operation inputs reach .nodrail/contracts.json for the Cloud hook", async () => {
    const p = await locked(
      withPolicy(`- required_engine_version: 4
- contracts:
    shapes:
      refund-args:
        properties:
          amount: { type: integer, min: 1, unit: usd_cents, report: true }
          card: { type: string, max: 40, classification: secret }
    connections:
      stripe:
        operations:
          refund: { input: refund-args }
- rule: Refunds
  tool: stripe
  operation: refund
  resource: { kind: mcp_tool, match: any }
  effect: allow
`),
    );
    const file = p.plan().files.find((each) => each.path === CONTRACTS_FILE);
    const body = JSON.parse(file!.content.toString("utf8")) as {
      version: number;
      inputs: Record<string, { name: string }>;
      briefs?: unknown;
    };
    expect(body.version).toBe(1);
    expect(Object.keys(body.inputs)).toEqual(["stripe.refund"]);
    expect(body.inputs["stripe.refund"]!.name).toBe("input:stripe.refund");
    expect(body.briefs).toBeUndefined();
  });
});

describe("plan and activation", () => {
  test("refuses across: environment locally, with the label and why", async () => {
    const p = await locked(withPolicy(SHARED));
    const { code, out } = await p.run("plan");
    expect(code).toBe(1);
    expect(out).toContain(
      "Publications per run: 3 calls per day (Europe/Madrid), across environment · Enforced allowance",
    );
    expect(out).toContain(
      "! Budget publications is across: environment: shared budgets are enforced only on a Cloud-managed connection",
    );
    expect((await p.run("apply", "--yes")).code).toBe(1);
    expect(existsSync(join(p.cwd, ".claude/settings.json"))).toBe(false);
  });

  test("shows each budget's label and how it is enforced here", async () => {
    const p = await locked(withPolicy(OUTBOX));
    const { code, out } = await p.run("plan", "--json");
    expect(code).toBe(0);
    const plan = JSON.parse(out) as {
      accountable: { budgets: { label: string; enforced: string }[] };
    };
    expect(plan.accountable.budgets).toMatchObject([
      {
        label: "Enforced allowance",
        enforced: expect.stringContaining("settled on PostToolUse"),
      },
    ]);
  });

  test("refuses runtime-observed evidence without the setup guard", async () => {
    const p = await locked(withPolicy(LOCAL));
    expect((await p.run("plan")).code).toBe(0);
    // Hooks off here: nothing keeps an agent from running nodrail.
    p.write(
      ".claude/settings.local.json",
      JSON.stringify({ disableAllHooks: true }),
    );
    const { code, out } = await p.run("plan");
    expect(code).toBe(1);
    expect(out).toContain(
      "Gate tested reads ci-tests as runtime-observed: runtime-observed evidence needs the setup guard",
    );
  });

  test("names the verifier an evidence requirement depends on, and resolves it with a token", async () => {
    const p = await locked(withPolicy(VERIFIED));
    const offline = await p.run("plan");
    expect(offline.out).toContain(
      "? Verifier github-actions: not checked: no token for https://app.nodrail.com here",
    );
    const answer = (items: unknown[]) =>
      (async () =>
        new Response(JSON.stringify({ items, next_cursor: null }), {
          status: 200,
        })) as unknown as typeof fetch;
    const plan = async (items: unknown[]) => {
      const io = fakeIo({
        cwd: p.cwd,
        home: p.home,
        env: { ...p.env, NODRAIL_TOKEN: "ndp_test" },
        fetch: answer(items),
      });
      const code = await io.run("plan");
      return { code, out: io.stdout() };
    };
    const verifier = {
      id: "v1",
      name: "github-actions",
      kind: "github-actions",
      repository: "acme/app",
      jobWorkflowRef: "acme/app/.github/workflows/ci.yml@refs/heads/main",
      environments: ["production"],
      audience: "https://app.nodrail.com/w/x",
      revokedAt: null,
    };
    const ok = await plan([verifier]);
    expect(ok.out).toContain(
      "✓ Verifier github-actions: github-actions for acme/app",
    );
    const revoked = await plan([
      { ...verifier, revokedAt: "2026-11-20T10:00:00.000Z" },
    ]);
    expect(revoked.code).toBe(1);
    expect(revoked.out).toContain(
      "! Verifier github-actions: verifier-missing: revoked on 2026-11-20",
    );
    expect((await plan([])).out).toContain(
      "verifier-missing: Cloud has no verifier by this name",
    );
  });

  test("contracts explain shows an evidence requirement's authority and producers, and a budget's label", async () => {
    const p = await locked(withPolicy(VERIFIED));
    const gate = await p.run("contracts", "explain", "tested");
    expect(gate.out).toContain(
      "1. evidence ci-tests, authority runtime-observed, about the current revision",
    );
    expect(gate.out).toContain(
      "Producers: externally-verified by verifier github-actions.",
    );
    expect(gate.out).toContain("Verifier github-actions: Cloud resolves it");
    expect(gate.out).toContain("And status is passed.");
    const q = await locked(withPolicy(SHARED));
    const budget = await q.run("contracts", "explain", "publications");
    expect(budget.out).toContain(
      'Budget "Publications per run" (id publications): Enforced allowance',
    );
    expect(budget.out).toContain("! Activation fails locally");
  });
});

describe("nodrail evidence run", () => {
  const script = (body: string) => [
    process.execPath,
    "-e",
    `const fs = require("node:fs"); ${body}`,
  ];

  test("records a valid value with the revision it is about", async () => {
    const p = await repoProject(LOCAL);
    const { code, err } = await p.run(
      "evidence",
      "run",
      "ci-tests",
      "--",
      ...script(
        `fs.writeFileSync(process.env.NODRAIL_EVIDENCE_OUT, JSON.stringify({ status: "passed", tests: 12 }))`,
      ),
    );
    expect(err).toContain("recorded ci-tests: valid, subject");
    expect(code).toBe(0);
    const [event] = readEvidence(join(p.cwd, ".git/nodrail/runs"), "ci-tests");
    expect(event).toMatchObject({
      producer: { class: "runtime-observed", id: "cli:evidence-run" },
      subject: {
        kind: "revision",
        digest: cleanRevision(git(p.cwd, "rev-parse", "HEAD")),
      },
      validation: { state: "valid", issues: [] },
      value: { status: "passed", tests: 12 },
      observed: { exit_code: 0 },
    });
    const shown = await p.run("evidence", "show", "ci-tests");
    expect(shown.out).toContain("(this revision)");
    expect(shown.out).toContain("Gate tested #1");
    expect(shown.out).toContain("met here");
  });

  test("nothing written to $NODRAIL_EVIDENCE_OUT is missing, whatever the exit code", async () => {
    const p = await repoProject(LOCAL);
    const { code, err } = await p.run(
      "evidence",
      "run",
      "ci-tests",
      "--",
      ...script("process.exit(0)"),
    );
    expect(code).toBe(1);
    expect(err).toContain(
      "missing: the command wrote nothing to $NODRAIL_EVIDENCE_OUT",
    );
    const [event] = readEvidence(join(p.cwd, ".git/nodrail/runs"), "ci-tests");
    expect(event!.validation).toEqual({ state: "missing", issues: [] });
    expect(event!.value).toBeNull();
    const shown = await p.run("evidence", "show", "ci-tests");
    expect(shown.out).toContain(
      "not met: the latest ci-tests for this revision has no result",
    );
  });

  test("work that changes while the command runs leaves the subject unknown", async () => {
    const p = await repoProject(LOCAL);
    const { err } = await p.run(
      "evidence",
      "run",
      "ci-tests",
      "--",
      ...script(
        `fs.writeFileSync("changed.txt", "edit"); fs.writeFileSync(process.env.NODRAIL_EVIDENCE_OUT, JSON.stringify({ status: "passed", tests: 1 }))`,
      ),
    );
    expect(err).toContain(
      "the work changed while it ran, so the subject is unknown",
    );
    const [event] = readEvidence(join(p.cwd, ".git/nodrail/runs"), "ci-tests");
    expect(event!.subject).toBeNull();
    expect(event!.validation.state).toBe("valid");
  });

  test("an invalid value is recorded invalid, without the value; the command's own failure is its exit", async () => {
    const p = await repoProject(LOCAL);
    const { code } = await p.run(
      "evidence",
      "run",
      "ci-tests",
      "--",
      ...script(
        `fs.writeFileSync(process.env.NODRAIL_EVIDENCE_OUT, JSON.stringify({ status: "green" })); process.exit(7)`,
      ),
    );
    expect(code).toBe(7);
    const [event] = readEvidence(join(p.cwd, ".git/nodrail/runs"), "ci-tests");
    expect(event!.validation.state).toBe("invalid");
    expect(event!.validation.issues.map((i) => i.path)).toEqual(
      expect.arrayContaining(["status", "tests"]),
    );
    expect(event!.value).toBeNull();
  });

  test("refuses evidence a gate doesn't read, or that isn't produced on this machine", async () => {
    const p = await repoProject(VERIFIED);
    const local = await p.run(
      "evidence",
      "run",
      "ci-tests",
      "--",
      ...script(""),
    );
    expect(local.code).toBe(1);
    expect(local.err).toContain(
      "ci-tests isn't produced as runtime-observed: its producers are externally-verified",
    );
    expect(
      (await p.run("evidence", "run", "other", "--", ...script(""))).err,
    ).toContain("No gate reads evidence named other. Known: ci-tests.");
    expect((await p.run("evidence", "run", "ci-tests")).code).toBe(2);
  });
});

describe("nodrail evidence submit", () => {
  const WORKSPACE = "6d1c2f0a-1111-4111-8111-111111111111";
  const SHA = "a".repeat(40);

  async function submitting(answers: (Response | Error)[]) {
    const p = await repoProject(VERIFIED);
    writeFileSync(
      join(p.cwd, "result.json"),
      JSON.stringify({ status: "passed", tests: 3 }),
    );
    const seen: { url: string; init?: RequestInit }[] = [];
    const queue = [...answers];
    const fetcher = (async (url: string | URL, init?: RequestInit) => {
      const target = String(url);
      seen.push({ url: target, init });
      if (target.startsWith("https://actions.example/"))
        return new Response(JSON.stringify({ value: "jwt.from.actions" }));
      const next = queue.shift()!;
      if (next instanceof Error) throw next;
      return next;
    }) as unknown as typeof fetch;
    const io = fakeIo({
      cwd: p.cwd,
      home: p.home,
      fetch: fetcher,
      env: {
        ...p.env,
        NODRAIL_URL: "https://nodrail.example",
        ACTIONS_ID_TOKEN_REQUEST_URL:
          "https://actions.example/token?api-version=2.0",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "actions-request-token",
        GITHUB_SHA: SHA,
      },
    });
    const code = await io.run(
      "evidence",
      "submit",
      "ci-tests",
      "--result",
      "result.json",
      "--workspace",
      WORKSPACE,
      "-e",
      "production",
      "--key",
      "unit",
    );
    return { code, seen, out: io.stdout(), err: io.stderr(), p };
  }

  test("asks GitHub Actions for an OIDC token for the workspace, then posts the value", async () => {
    const { code, seen, out } = await submitting([
      new Response(
        JSON.stringify({
          id: "e1",
          subject: cleanRevision(SHA),
          validation: "valid",
          issues: [],
          replayed: false,
        }),
      ),
    ]);
    expect(code).toBe(SUBMIT_EXIT.stored);
    const oidc = new URL(seen[0]!.url);
    expect(oidc.origin + oidc.pathname).toBe("https://actions.example/token");
    expect(oidc.searchParams.get("api-version")).toBe("2.0");
    expect(oidc.searchParams.get("audience")).toBe(
      `https://nodrail.example/w/${WORKSPACE}`,
    );
    expect(
      (seen[0]!.init!.headers as Record<string, string>).authorization,
    ).toBe("Bearer actions-request-token");
    expect(seen[1]!.url).toBe("https://nodrail.example/api/v1/evidence");
    expect(
      (seen[1]!.init!.headers as Record<string, string>).authorization,
    ).toBe("Bearer jwt.from.actions");
    const body = JSON.parse(seen[1]!.init!.body as string) as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({
      workspace: WORKSPACE,
      environment: "production",
      evidence: "ci-tests",
      event_key: "unit",
      commit: SHA,
      value: { status: "passed", tests: 3 },
    });
    expect(body.contract).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(out).toContain("Stored ci-tests for");
    expect(out).toContain("valid");
  });

  test("a refusal exits 3 with its code; an unreachable Cloud is retried, then exits 4", async () => {
    const refused = await submitting([
      new Response(
        JSON.stringify({ error: { code: "producer-not-allowed" } }),
        { status: 403 },
      ),
    ]);
    expect(refused.code).toBe(SUBMIT_EXIT.rejected);
    expect(refused.err).toContain(
      "Cloud refused ci-tests: producer-not-allowed",
    );
    const down = await submitting([
      new Error("ECONNREFUSED"),
      new Response("", { status: 503 }),
      new Error("ECONNREFUSED"),
    ]);
    expect(down.code).toBe(SUBMIT_EXIT.unreachable);
    const posts = down.seen.filter((s) => s.url.endsWith("/api/v1/evidence"));
    expect(posts).toHaveLength(3);
    // The same body each time, so a retry that did arrive is idempotent.
    expect(new Set(posts.map((s) => s.init!.body as string)).size).toBe(1);
    const later = await submitting([
      new Response("", { status: 503 }),
      new Response(
        JSON.stringify({ id: "e2", validation: "valid", replayed: true }),
      ),
    ]);
    expect(later.code).toBe(SUBMIT_EXIT.stored);
    expect(later.out).toContain("already stored");
  });

  test("outside GitHub Actions there is no token to ask for", async () => {
    const p = await repoProject(VERIFIED);
    writeFileSync(join(p.cwd, "result.json"), "{}");
    const { code, err } = await p.run(
      "evidence",
      "submit",
      "ci-tests",
      "--result",
      "result.json",
      "--workspace",
      WORKSPACE,
      "-e",
      "production",
    );
    expect(code).toBe(1);
    expect(err).toContain("permissions: id-token: write");
  });
});

describe("the outbox end to end, through nodrail policy hook", () => {
  test("three publications go ahead, the fourth is held, PostToolUse settles, budgets status and reconcile", async () => {
    const p = await repoProject(OUTBOX);
    expect((await p.run("apply", "--yes")).code).toBe(0);
    const settings = JSON.parse(p.read(".claude/settings.json")) as Settings;
    // The command the host runs, with the project folder in place.
    const command = settings.hooks.PostToolUse![0]!.hooks[0]!.command;
    expect(settings.hooks.PreToolUse![0]!.hooks[0]!.command).toBe(command);
    const argv = [...command.matchAll(/"([^"]+)"|(\S+)/g)]
      .map((m) => m[1] ?? m[2]!)
      .slice(1)
      .map((word) => word.replace("$CLAUDE_PROJECT_DIR", p.cwd));
    expect(argv.slice(0, 2)).toEqual(["policy", "hook"]);
    process.env.NODRAIL_RUN = "outbox-e2e";
    const call = (name: string, id: string) =>
      p.runWith(
        {
          stdin: JSON.stringify({
            hook_event_name: name,
            session_id: "s-1",
            cwd: p.cwd,
            tool_name: "mcp__outbox__publish",
            tool_input: { n: id },
            tool_use_id: id,
            ...(name === "PreToolUse" ? {} : { tool_response: {} }),
          }),
        },
        ...argv,
      );
    const decision = (out: string) =>
      out
        ? (
            JSON.parse(out) as {
              hookSpecificOutput: {
                permissionDecision: string;
                permissionDecisionReason: string;
              };
            }
          ).hookSpecificOutput
        : { permissionDecision: "allow", permissionDecisionReason: "" };
    const asked = async (id: string) =>
      decision((await call("PreToolUse", id)).out).permissionDecision;
    for (const id of ["t1", "t2", "t3"]) expect(await asked(id)).toBe("allow");
    const fourth = await call("PreToolUse", "t4");
    expect(decision(fourth.out).permissionDecision).toBe("deny");
    expect(decision(fourth.out).permissionDecisionReason).toContain(
      "Budget publications is at 3 of 3 calls (enforced allowance)",
    );
    // The outcomes: t1 and t2 ran, t3 failed with no mediated record.
    for (const id of ["t1", "t2"])
      expect((await call("PostToolUse", id)).code).toBe(0);
    expect((await call("PostToolUseFailure", "t3")).code).toBe(0);
    const status = await p.run("budgets", "status");
    expect(status.code).toBe(0);
    expect(status.out).toContain(
      "publications · Enforced allowance · per run, across run",
    );
    expect(status.out).toContain("outbox-e2e: 3 of 3 calls, 1 unknown");
    expect(status.out).toContain(
      "claude-code:t3  publications 1 calls  unknown",
    );
    // The person knows t3 never reached the outbox: the slot comes back.
    const usage = await p.run(
      "budgets",
      "reconcile",
      "claude-code:t3",
      "--released",
    );
    expect(usage.code).toBe(2);
    const reconciled = await p.run(
      "budgets",
      "reconcile",
      "claude-code:t3",
      "--released",
      "--note",
      "the outbox log shows no third message",
    );
    expect(reconciled.out).toContain(
      "Reconciled claude-code:t3 in run outbox-e2e: unknown → released",
    );
    expect(await asked("t5")).toBe("allow");
    const json = JSON.parse(
      (await p.run("budgets", "status", "--json")).out,
    ) as {
      budgets: { runs: { state: { used: number; reserved: number } }[] }[];
    };
    expect(json.budgets[0]!.runs[0]!.state).toMatchObject({
      used: 3,
      reserved: 1,
    });
    expect(
      (await p.run("budgets", "reconcile", "nope", "--consumed", "--note", "x"))
        .err,
    ).toContain("No reservation nope");
  });
});

describe("an agent can't forge local evidence (R364)", () => {
  // The audit's repro: a rule allows Write anywhere, the person's run
  // failed, and the agent appends a passed event to the ledger, then pushes.
  const WRITES = `- rule: Write files
  tool: files
  operation: file.write
  resource: { kind: file, match: any }
  effect: allow
- rule: Any compound
  tool: shell
  operation: command.compound
  resource: { kind: command, match: any }
  effect: allow
`;

  test("the hook denies the write, the append and the gate", async () => {
    const p = await repoProject(`${LOCAL}${WRITES}`);
    expect((await p.run("apply", "--yes")).code).toBe(0);
    const ran = await p.run(
      "evidence",
      "run",
      "ci-tests",
      "--",
      process.execPath,
      "-e",
      `require("node:fs").writeFileSync(process.env.NODRAIL_EVIDENCE_OUT, JSON.stringify({ status: "failed", tests: 3 }))`,
    );
    expect(ran.err).toContain("recorded ci-tests: valid");
    const ledger = join(p.cwd, ".git/nodrail/runs/evidence/ci-tests.jsonl");
    const [failed] = readEvidence(join(p.cwd, ".git/nodrail/runs"), "ci-tests");
    const forged = JSON.stringify({
      ...failed,
      event: "4f0b3c1e-8a52-4d7e-9a8e-2c6d1f0b7a11",
      value: { status: "passed", tests: 3 },
    });
    const settings = JSON.parse(p.read(".claude/settings.json")) as Settings;
    const argv = [
      ...settings.hooks.PreToolUse![0]!.hooks[0]!.command.matchAll(
        /"([^"]+)"|(\S+)/g,
      ),
    ]
      .map((m) => m[1] ?? m[2]!)
      .slice(1)
      .map((word) => word.replace("$CLAUDE_PROJECT_DIR", p.cwd));
    const decide = async (tool_name: string, tool_input: object) => {
      const { out } = await p.runWith(
        {
          stdin: JSON.stringify({
            hook_event_name: "PreToolUse",
            session_id: "s-forge",
            cwd: p.cwd,
            tool_name,
            tool_input,
            tool_use_id: tool_name,
          }),
        },
        ...argv,
      );
      return out
        ? (JSON.parse(out) as { hookSpecificOutput: Record<string, string> })
            .hookSpecificOutput.permissionDecision
        : "allow";
    };
    expect(
      await decide("Write", { file_path: ledger, content: `${forged}\n` }),
    ).toBe("deny");
    expect(
      await decide("Bash", {
        command: `echo '${forged}' >> .git/nodrail/runs/evidence/ci-tests.jsonl`,
      }),
    ).toBe("deny");
    // A file elsewhere is still the rules' to decide.
    expect(
      await decide("Write", {
        file_path: join(p.cwd, "notes.md"),
        content: "x",
      }),
    ).toBe("allow");
    expect(await decide("Bash", { command: "git push" })).toBe("deny");
    const shown = await p.run("evidence", "show", "ci-tests");
    expect(shown.out).toContain("not met");
  });

  test("plan fails without the guard that keeps agents out of the ledger; status sees the same", async () => {
    const p = await locked(withPolicy(LOCAL));
    expect((await p.run("apply", "--yes")).code).toBe(0);
    // The project's own settings turn hooks off: plan and status both see it.
    const settings = JSON.parse(p.read(".claude/settings.json")) as object;
    p.write(
      ".claude/settings.json",
      JSON.stringify({ ...settings, disableAllHooks: true }),
    );
    const refused = await p.run("plan");
    expect(refused.code).toBe(1);
    expect(refused.out).toContain("or write the run ledger");
    const status = await p.run("status");
    expect(`${status.out}${status.err}`).toContain(
      ".claude/settings.json sets disableAllHooks, so no hook runs",
    );
    expect(status.out).not.toContain("Since apply: nothing changed");
    expect(status.out).toContain(
      "! .claude/settings.json  disableAllHooks is on, so no hook runs",
    );
    // A hook edited to drop its protect list is a change too.
    p.write(
      ".claude/settings.json",
      p
        .read(".claude/settings.json")
        .replaceAll(/ --protect-list \\"[^"\\]*\\"/g, "")
        .replace('"disableAllHooks":true', '"disableAllHooks":false'),
    );
    expect((await p.run("status")).out).toContain(
      "the policy hook no longer has its protect list",
    );
  });

  test("status reports a policy hook removed or narrowed since apply", async () => {
    const p = await locked(withPolicy(LOCAL));
    expect((await p.run("apply", "--yes")).code).toBe(0);
    expect((await p.run("status")).out).toContain(
      "Since apply: nothing changed",
    );
    const applied = JSON.parse(p.read(".claude/settings.json")) as Settings;
    const edit = (change: (s: Settings) => void) => {
      const copy = structuredClone(applied);
      change(copy);
      p.write(".claude/settings.json", JSON.stringify(copy));
    };
    edit((s) => {
      s.hooks.PreToolUse![0]!.matcher = "Read";
    });
    const narrowed = (await p.run("status")).out;
    expect(narrowed).not.toContain("nothing changed");
    expect(narrowed).toContain(
      "the policy hook on PreToolUse only matches Read",
    );
    edit((s) => {
      delete s.hooks.PreToolUse;
    });
    expect((await p.run("status")).out).toContain(
      "the policy hook on PreToolUse is gone",
    );
    edit((s) => {
      delete s.hooks.SubagentStop;
    });
    expect((await p.run("status")).out).toContain(
      "the policy hook on SubagentStop is gone",
    );
  });
});

describe("usage and edges", () => {
  test("evidence and budgets say how they are used", async () => {
    const p = await repoProject(LOCAL);
    for (const command of ["evidence", "budgets"]) {
      const help = await p.run(command, "--help");
      expect(help.code).toBe(0);
      expect(help.out).toContain(`nodrail ${command}`);
      expect((await p.run(command)).code).toBe(2);
      expect((await p.run(command, "nope")).code).toBe(2);
    }
    expect((await p.run("evidence", "show", "ci-tests", "--bad")).code).toBe(2);
    expect((await p.run("evidence", "show")).code).toBe(2);
    expect(
      (await p.run("evidence", "submit", "ci-tests", "--result", "r.json")).err,
    ).toContain("--workspace (or NODRAIL_WORKSPACE)");
    expect((await p.run("budgets", "reconcile", "k", "--consumed")).code).toBe(
      2,
    );
  });

  test("budgets status needs numeric budgets; show works without any event", async () => {
    const p = await repoProject(LOCAL);
    const status = await p.run("budgets", "status");
    expect(status.code).toBe(1);
    expect(status.err).toContain("The policy has no numeric budgets");
    const shown = JSON.parse(
      (await p.run("evidence", "show", "ci-tests", "--json")).out,
    ) as { events: unknown[]; gates: { unmet: string }[] };
    expect(shown.events).toEqual([]);
    expect(shown.gates[0]!.unmet).toBe("no ci-tests for this revision");
    const q = await repoProject(
      SHARED.replace("across: environment", "across: run"),
    );
    const empty = await q.run(
      "budgets",
      "status",
      "--policy",
      "policies/base.yaml",
    );
    expect(empty.out).toContain("no run has used it");
    expect(
      (await q.run("budgets", "status", "--run", "missing")).err,
    ).toContain('No run called "missing"');
  });
});
