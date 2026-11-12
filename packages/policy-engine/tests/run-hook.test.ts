// The Claude Code hook with a run ledger, end to end: real Claude Code events
// through `nodrail-policy hook`, in a scratch git repository, with the ledger
// where it really goes. Only the transport is in-process.
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { cli } from "./run-cli.ts";

const RULES = `
- required_engine_version: 3
- list: builders
  items: [dev]
- rule: Start any subagent
  tool: claude-code
  operation: agent
  resource: { kind: agent, match: any }
  effect: allow
- rule: Look around
  command: ls
  effect: allow
- rule: Use git
  command: { prefix: git }
  effect: allow
- gate: Review before the pull request
  id: review-before-pr
  tool: claude-code
  operation: agent
  resource: { kind: agent, match: exact, value: github }
  requires:
    - { agent: qa, verdict: pass, since: { list: builders } }
    - { agent: reviewer, verdict: [ship, ship_with_debt], since: { list: builders } }
  otherwise: require_approval
- gate: Review before a push
  id: review-before-push
  command: { prefix: git push }
  requires:
    - { agent: reviewer, verdict: ship, since: { list: builders } }
  otherwise: deny
- budget: Builder step
  id: builder-step
  step_agent: dev
  per: step
  tool_calls: 2
  otherwise: require_approval
`;

function scratchRepository(rules = RULES) {
  const repo = mkdtempSync(join(tmpdir(), "nodrail-run-"));
  spawnSync("git", ["init", "-q", "-b", "feature/login"], { cwd: repo });
  const file = join(repo, "rules.yaml");
  writeFileSync(file, rules);
  return {
    repo,
    file,
    ledger: join(repo, ".git", "nodrail", "runs"),
    // No remote, so the repository is named by its folder.
    run: `${basename(repo)}/feature/login`,
  };
}

type Session = ReturnType<typeof session>;

/** A Claude Code session sending its hook events to the hook. */
function session(repo: string, file: string) {
  const base = { session_id: "s-1", cwd: repo, transcript_path: "/dev/null" };
  const send = (event: object) =>
    cli(["hook", file], JSON.stringify({ ...base, ...event }));
  const from = (agent?: { id: string; type: string }) =>
    agent ? { agent_id: agent.id, agent_type: agent.type } : {};
  return {
    dispatch: (type: string) =>
      send({
        hook_event_name: "PreToolUse",
        tool_name: "Agent",
        tool_input: { subagent_type: type, description: type, prompt: "go" },
      }),
    bash: (command: string, agent?: { id: string; type: string }) =>
      send({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command },
        ...from(agent),
      }),
    write: (path: string, agent?: { id: string; type: string }) =>
      send({
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: { file_path: path, content: "x" },
        ...from(agent),
      }),
    start: (id: string, type: string) =>
      send({
        hook_event_name: "SubagentStart",
        agent_id: id,
        agent_type: type,
      }),
    stop: (id: string, type: string, message: string) =>
      send({
        hook_event_name: "SubagentStop",
        agent_id: id,
        agent_type: type,
        last_assistant_message: message,
        stop_hook_active: false,
      }),
  };
}

const receipt = (verdict: string) =>
  `Done.\n\n\`\`\`nodrail-receipt\nverdict: ${verdict}\n\`\`\`\n`;

async function step(s: Session, id: string, type: string, verdict: string) {
  await s.start(id, type);
  await s.stop(id, type, receipt(verdict));
}

const decision = (stdout: string) =>
  stdout
    ? (
        JSON.parse(stdout) as {
          hookSpecificOutput: {
            permissionDecision: string;
            permissionDecisionReason: string;
          };
        }
      ).hookSpecificOutput
    : { permissionDecision: "allow", permissionDecisionReason: "" };

const saved = process.env.NODRAIL_LEDGER;
afterEach(() => {
  if (saved === undefined) delete process.env.NODRAIL_LEDGER;
  else process.env.NODRAIL_LEDGER = saved;
});

describe("a run through the Claude Code hook", () => {
  test("the pull request waits for QA and review after the last build", async () => {
    const { repo, file } = scratchRepository();
    const s = session(repo, file);

    const early = decision((await s.dispatch("github")).stdout);
    expect(early).toMatchObject({
      permissionDecision: "ask",
      permissionDecisionReason:
        "Nodrail: Gate review-before-pr needs qa with pass after the last change or dev work; reviewer with ship or ship_with_debt after the last change or dev work. Until then, a person must review claude-code agent on github.",
    });

    await step(s, "d1", "dev", "done");
    await step(s, "q1", "qa", "fail");
    await step(s, "r1", "reviewer", "ship");
    expect(
      decision((await s.dispatch("github")).stdout).permissionDecision,
    ).toBe("ask");

    await step(s, "q2", "QA", "PASS");
    expect(
      decision((await s.dispatch("github")).stdout).permissionDecision,
    ).toBe("allow");

    await s.start("d2", "dev");
    const again = decision((await s.dispatch("github")).stdout);
    expect(again.permissionDecision).toBe("ask");
  });

  test("the main agent cannot push around the gate", async () => {
    const { repo, file } = scratchRepository();
    const s = session(repo, file);
    expect(
      decision((await s.bash("git push origin main")).stdout)
        .permissionDecision,
    ).toBe("deny");
    expect(
      decision((await s.bash("git add . && git push")).stdout)
        .permissionDecision,
    ).toBe("deny");
    await step(s, "d1", "dev", "done");
    await step(s, "r1", "reviewer", "ship");
    expect((await s.bash("git push origin main")).stdout).toBe("");
  });

  test("a builder step is held at its tool call budget", async () => {
    const { repo, file } = scratchRepository();
    const s = session(repo, file);
    const dev = { id: "d1", type: "dev" };
    await s.start(dev.id, dev.type);
    expect((await s.bash("ls", dev)).stdout).toBe("");
    expect((await s.bash("ls", dev)).stdout).toBe("");
    const third = decision((await s.bash("ls", dev)).stdout);
    expect(third).toMatchObject({ permissionDecision: "ask" });
    expect(third.permissionDecisionReason).toContain(
      "Budget builder-step is at 3 of 2 tool calls. Over the limit, a person must review",
    );
    // Another step of the same agent starts with a fresh budget.
    expect((await s.bash("ls", { id: "d2", type: "dev" })).stdout).toBe("");
  });

  test("a receipt quoted in the middle of a report settles nothing", async () => {
    const { repo, file } = scratchRepository();
    const s = session(repo, file);
    await step(s, "d1", "dev", "done");
    await s.start("q1", "qa");
    await s.stop("q1", "qa", `${receipt("pass")}\nThen the tests failed.`);
    await step(s, "r1", "reviewer", "ship");
    expect(
      decision((await s.dispatch("github")).stdout).permissionDecision,
    ).toBe("ask");
  });

  test("the ledger is in the git folder, one file per run, and can be read", async () => {
    const { repo, file, ledger, run } = scratchRepository();
    const s = session(repo, file);
    await step(s, "d1", "dev", "done");
    await s.bash("git push");
    expect(
      readdirSync(ledger).filter((name) => name.endsWith(".jsonl")),
    ).toEqual([
      expect.stringMatching(
        /^nodrail-run-.*-feature-login\.[0-9a-f]{12}\.jsonl$/,
      ),
    ]);

    process.env.NODRAIL_LEDGER = ledger;
    expect((await cli(["runs"])).stdout).toContain(`${run}  1 steps, 3 events`);
    const shown = (await cli(["runs", "show", run])).stdout;
    expect(shown).toContain("dev started");
    expect(shown).toContain("dev finished: done");
    expect(shown).toContain("main shell command.run: deny");
    expect((await cli(["runs", "report"])).stdout).toContain(
      "dev: 1 steps (done 1), 0 actions held",
    );
    expect((await cli(["runs", "show", "nope"])).code).toBe(1);
    expect((await cli(["runs", "sideways"])).code).toBe(2);
  });

  test("a damaged ledger blocks instead of forgetting", async () => {
    const { repo, file, ledger } = scratchRepository();
    const s = session(repo, file);
    await step(s, "d1", "dev", "done");
    const [name = ""] = readdirSync(ledger);
    appendFileSync(join(ledger, name), "{not json\n");
    const result = decision((await s.bash("ls")).stdout);
    expect(result.permissionDecision).toBe("deny");
    expect(result.permissionDecisionReason).toContain("can't be read");
  });

  test("NODRAIL_RUN names the run instead of the branch", async () => {
    const { repo, file, ledger } = scratchRepository();
    process.env.NODRAIL_RUN = "ENG-42";
    try {
      await step(session(repo, file), "d1", "dev", "done");
    } finally {
      delete process.env.NODRAIL_RUN;
    }
    expect(readdirSync(ledger)).toEqual([expect.stringMatching(/^ENG-42\./)]);
  });

  test("rules without gates or budgets never write a ledger", async () => {
    const { repo, file, ledger } = scratchRepository(
      "- rule: Look around\n  command: ls\n  effect: allow\n",
    );
    const s = session(repo, file);
    expect((await s.bash("ls")).stdout).toBe("");
    await step(s, "d1", "dev", "done");
    expect(existsSync(ledger)).toBe(false);
  });
});

const WRITES = `${RULES}
- rule: Write in the project
  tool: files
  operation: file.write
  resource: { kind: file, match: any }
  condition:
    - { field: inside_cwd, op: eq, value: true }
  effect: allow
`;

const pushDecision = async (s: Session) =>
  decision((await s.bash("git push")).stdout).permissionDecision;

describe("what counts as work after a review", () => {
  async function reviewed(rules = WRITES) {
    const scratch = scratchRepository(rules);
    const s = session(scratch.repo, scratch.file);
    await step(s, "d1", "dev", "done");
    await step(s, "r1", "reviewer", "ship");
    return { ...scratch, s };
  }

  test("the main agent writing a file after the review closes the gate", async () => {
    const { repo, s } = await reviewed();
    expect((await s.write(join(repo, "app.ts"))).stdout).toBe("");
    expect(await pushDecision(s)).toBe("deny");
  });

  test("a general-purpose subagent committing after the review closes it", async () => {
    const { s } = await reviewed();
    const helper = { id: "g1", type: "general-purpose" };
    await s.start(helper.id, helper.type);
    expect((await s.bash("git commit -m x", helper)).stdout).toBe("");
    expect(await pushDecision(s)).toBe("deny");
  });

  test("looking around, or starting another reviewer, keeps it open", async () => {
    const { s } = await reviewed();
    expect((await s.bash("git status")).stdout).toBe("");
    expect((await s.dispatch("reviewer")).stdout).toBe("");
    expect(await pushDecision(s)).toBe("allow");
  });

  test("a write that was denied changed nothing", async () => {
    const { s } = await reviewed(RULES);
    const denied = decision((await s.write("/etc/hosts")).stdout);
    expect(denied.permissionDecision).toBe("deny");
    expect(await pushDecision(s)).toBe("allow");
  });
});

describe("the run a session belongs to", () => {
  test("switching branch doesn't leave the review behind, nor escape a gate", async () => {
    const { repo, file } = scratchRepository();
    const s = session(repo, file);
    await step(s, "d1", "dev", "done");
    spawnSync("git", ["switch", "-q", "--orphan", "feature/other"], {
      cwd: repo,
    });
    await step(s, "r1", "reviewer", "ship");
    // Both steps are in the run the session started in.
    expect(await pushDecision(s)).toBe("allow");
    await s.start("d2", "dev");
    expect(await pushDecision(s)).toBe("deny");
  });

  test("on the default branch the run is the session", async () => {
    const { repo, file, ledger } = scratchRepository();
    spawnSync("git", ["switch", "-q", "--orphan", "main"], { cwd: repo });
    await step(session(repo, file), "d1", "dev", "done");
    expect(
      readdirSync(ledger).filter((name) => name.endsWith(".jsonl")),
    ).toEqual([expect.stringMatching(/^session-s-1\./)]);
  });
});

describe("the rules the hook enforces", () => {
  test("no file tool may change them, whatever the rules allow", async () => {
    const { repo, file, s } = await (async () => {
      const scratch = scratchRepository(WRITES);
      return { ...scratch, s: session(scratch.repo, scratch.file) };
    })();
    expect((await s.write(join(repo, "other.ts"))).stdout).toBe("");
    const result = decision((await s.write(file)).stdout);
    expect(result.permissionDecision).toBe("deny");
    expect(result.permissionDecisionReason).toContain(
      "holds the rules this hook enforces",
    );
  });

  test("a folder of rules protects every file in it", async () => {
    const { repo } = scratchRepository();
    const folder = join(repo, ".claude", "nodrail");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "rules.yaml"), WRITES);
    const s = session(repo, folder);
    for (const target of [join(folder, "rules.yaml"), join(folder, "new.yaml")])
      expect(decision((await s.write(target)).stdout).permissionDecision).toBe(
        "deny",
      );
  });

  test("rules without gates are protected too", async () => {
    const { repo, file } = scratchRepository(
      "- rule: Write\n  tool: files\n  operation: file.write\n  resource: { kind: file, match: any }\n  effect: allow\n",
    );
    const s = session(repo, file);
    expect(decision((await s.write(file)).stdout).permissionDecision).toBe(
      "deny",
    );
  });
});

describe("a ledger that two hooks share", () => {
  test("a last line cut off while it was written is left out, then cut away", async () => {
    const { repo, file, ledger } = scratchRepository();
    const s = session(repo, file);
    await step(s, "d1", "dev", "done");
    const [name = ""] = readdirSync(ledger).filter((n) => n.endsWith(".jsonl"));
    appendFileSync(join(ledger, name), '{"run":"cut');
    expect((await s.bash("ls")).stdout).toBe("");
    expect((await s.bash("ls")).stdout).toBe("");
    const text = readFileSync(join(ledger, name), "utf8");
    expect(text).not.toContain('{"run":"cut');
    expect(text.trimEnd().split("\n")).toHaveLength(4);
  });

  test("a lock left by a hook that died long ago is taken over", async () => {
    const { repo, file, ledger } = scratchRepository();
    const s = session(repo, file);
    await step(s, "d1", "dev", "done");
    const [name = ""] = readdirSync(ledger).filter((n) => n.endsWith(".jsonl"));
    const lock = join(ledger, `${name}.lock`);
    writeFileSync(lock, "");
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    expect((await s.bash("ls")).stdout).toBe("");
    expect(existsSync(lock)).toBe(false);
  });

  test("a run another hook keeps busy blocks the action", async () => {
    const { repo, file, ledger } = scratchRepository();
    const s = session(repo, file);
    await step(s, "d1", "dev", "done");
    const [name = ""] = readdirSync(ledger).filter((n) => n.endsWith(".jsonl"));
    writeFileSync(join(ledger, `${name}.lock`), "");
    const result = decision((await s.bash("ls")).stdout);
    expect(result.permissionDecision).toBe("deny");
    expect(result.permissionDecisionReason).toContain("is busy");
  }, 15_000);
});

describe("testing gates in a cases file", () => {
  test("cases can carry a run, so gates and budgets are tested like rules", async () => {
    const { repo, file } = scratchRepository();
    const cases = join(repo, "cases.yaml");
    writeFileSync(
      cases,
      `
- name: no review yet
  call: { tool: claude-code, operation: agent, kind: agent, resource: github }
  expect: require_approval
- name: reviewed after the last build
  call: { tool: claude-code, operation: agent, kind: agent, resource: github }
  run:
    - { started: dev }
    - { finished: dev, verdict: done }
    - { finished: qa, verdict: pass }
    - { finished: reviewer, verdict: ship }
  expect: allow
- name: a third call in one dev step
  call: { command: ls }
  run:
    - { started: dev }
    - { action: dev }
    - { action: dev }
  step: dev
  expect: require_approval
- name: the main agent changed something after the review
  call: { command: git push }
  run:
    - { finished: dev, verdict: done }
    - { finished: reviewer, verdict: ship }
    - { action: main }
  expect: deny
- name: the main agent only looked after the review
  call: { command: git push }
  run:
    - { finished: dev, verdict: done }
    - { finished: reviewer, verdict: ship }
    - { action: main, command: git status }
  expect: allow
`,
    );
    const result = await cli(["test", file, "--cases", cases]);
    expect(result.stdout).toContain("5 of 5 passed.");
    expect(result.code).toBe(0);
  });
});
