// Gates on declared contracts, end to end through
// `nodrail-policy hook` in a scratch git repository: receipts captured on the
// stop event and on a hand-back, read against their contract, and gates
// that need verdicts, `where`, recorded freshness and the revision.
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { compilePolicies, renderPolicies } from "../src/yaml";
import { guardHook, hookIsStep } from "../src/hook-guard";
import { cli } from "./run-cli.ts";
import { hookAnswer, scratchRepo } from "./support/hook-answers.ts";

const CONTRACTS = `
- required_engine_version: 4
- contracts:
    shapes:
      reviewer-result:
        properties:
          verdict: { values: [ship, ship-with-debt, fix-first], role: verdict }
          findings:
            role: findings
            properties:
              blocker: { type: integer, min: 0 }
              major: { type: integer, min: 0 }
          anchor: { values: [fresh, stale] }
      qa-result:
        properties:
          result: { values: [pass, fail], role: verdict }
          issue: { type: string, max: 100 }
    receipts:
      reviewer: { shape: reviewer-result }
      qa:
        shape: qa-result
        format: header
        header: { title: "RECEIPT {agent}", aliases: { result: result } }
- list: builders
  items: [dev]
- rule: Start any subagent
  tool: claude-code
  operation: agent
  resource: { kind: agent, match: any }
  effect: allow
- rule: Hand back
  tool: claude-code
  operation: subagenthandback
  resource: { kind: tool, match: any }
  effect: allow
- rule: Write files
  tool: files
  operation: write
  resource: { kind: path, match: any }
  effect: allow
`;

const GATE = `
- gate: Reviewed before the pull request
  id: reviewed
  tool: claude-code
  operation: agent
  resource: { kind: agent, match: exact, value: github }
  requires:
    - agent: reviewer
      verdict: [ship, ship-with-debt]
      since: { list: builders }
      where: { findings.blocker: 0, findings.major: { max: 2 } }
    - { agent: qa, verdict: pass, since: { list: builders } }
  otherwise: deny
`;

const scratch = (rules: string) =>
  scratchRepo(rules, "nodrail-contracts-", "feature/x");

type Agent = { id: string; type: string };

function session(repo: string, file: string, host: string[] = []) {
  const base = { session_id: "s-1", cwd: repo, transcript_path: "/dev/null" };
  const send = (event: object) =>
    cli(["hook", file, ...host], JSON.stringify({ ...base, ...event }));
  const from = ({ id, type }: Agent) => ({ agent_id: id, agent_type: type });
  return {
    send,
    dispatch: (type: string) =>
      send({
        hook_event_name: "PreToolUse",
        tool_name: "Agent",
        tool_input: { subagent_type: type, description: type, prompt: "go" },
      }),
    start: (agent: Agent) =>
      send({ hook_event_name: "SubagentStart", ...from(agent) }),
    stop: (agent: Agent, message?: string) =>
      send({
        hook_event_name: "SubagentStop",
        ...from(agent),
        ...(message === undefined ? {} : { last_assistant_message: message }),
      }),
    handback: (agent: Agent, message: string) =>
      send({
        hook_event_name: "PreToolUse",
        tool_name: "SubagentHandback",
        tool_input: { message },
        tool_use_id: "toolu_1",
        ...from(agent),
      }),
    write: (agent: Agent, path: string) =>
      send({
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: { file_path: path, content: "x" },
        ...from(agent),
      }),
  };
}

const reviewer = (verdict: string, blocker = 0) =>
  `Reviewed.\n\n\`\`\`nodrail-receipt\nagent: reviewer\nverdict: ${verdict}\nfindings: { blocker: ${blocker}, major: 1 }\nanchor: fresh\n\`\`\`\n`;
const qa = (result: string) =>
  `Checked.\n\n**RECEIPT qa**\nresult: ${result}\nissue: ENG-1\nbudget: 3/30\n`;

const answer = hookAnswer;

/** Every step.finished the ledger holds, in order. */
function finishes(repo: string) {
  const folder = join(repo, ".git", "nodrail", "runs");
  return readdirSync(folder)
    .filter((name) => name.endsWith(".jsonl"))
    .flatMap((name) =>
      readFileSync(join(folder, name), "utf8")
        .split("\n")
        .filter(Boolean)
        .map(
          (line) =>
            (JSON.parse(line) as { event: Record<string, unknown> }).event,
        ),
    )
    .filter((event) => event.type === "step.finished");
}

async function finished(
  s: ReturnType<typeof session>,
  agent: Agent,
  message: string,
) {
  await s.start(agent);
  await s.stop(agent, message);
}

describe("compiling contracts in rule files", () => {
  test("contracts and a gate with where compile to a version 3 document", () => {
    const result = compilePolicies([
      { name: "a.yaml", text: CONTRACTS + GATE },
    ]);
    expect(result.ok && result.document.version).toBe(3);
    if (!result.ok || result.document.version !== 3) return;
    expect(Object.keys(result.document.receipts).sort()).toEqual([
      "qa",
      "reviewer",
    ]);
    const [review, check] = result.document.gates[0]!.requires;
    expect(review).toMatchObject({
      agent: "reviewer",
      contract: result.document.receipts.reviewer!.contract,
      authority: "agent-reported",
      subject: null,
      where: [
        { path: ["findings", "blocker"], op: "eq", value: 0 },
        { path: ["findings", "major"], op: "range", min: null, max: 2 },
      ],
    });
    expect(check).toMatchObject({ agent: "qa", where: [] });
  });

  test("the rule file in docs/contracts.md compiles to a version 3 document", () => {
    const page = readFileSync(
      join(import.meta.dirname, "../docs/contracts.md"),
      "utf8",
    );
    const [, text = ""] =
      /^```yaml\n(- required_engine_version: 4[\s\S]*?)^```$/m.exec(page) ?? [];
    const result = compilePolicies([{ name: "doc.yaml", text }]);
    expect(result.ok && result.document.version).toBe(3);
  });

  test("rendering gives back rule files that compile to the same document", () => {
    const result = compilePolicies([
      { name: "a.yaml", text: CONTRACTS + GATE },
    ]);
    if (!result.ok) throw new Error("expected to compile");
    const again = compilePolicies([
      { name: "b.yaml", text: renderPolicies(result.document) },
    ]);
    expect(again.ok && again.document).toEqual(result.document);
  });

  test.each([
    [
      "a where without a contracts entry",
      `- required_engine_version: 4\n${GATE.replace("- { agent: qa, verdict: pass, since: { list: builders } }", "").replace("since: { list: builders }\n", "\n")}`,
      "declare it in a contracts entry",
    ],
    [
      "contracts in a file that doesn't ask for level 4",
      CONTRACTS.replace(
        "required_engine_version: 4",
        "required_engine_version: 3",
      ),
      "need required_engine_version: 4",
    ],
    [
      "a verdict the receipt can't give",
      CONTRACTS + GATE.replace("[ship, ship-with-debt]", "[ship, done]"),
      "done isn't a verdict this receipt can give",
    ],
    [
      "more authority than a receipt has",
      CONTRACTS +
        GATE.replace(
          "where: {",
          "authority: externally-verified\n      where: {",
        ),
      "A receipt is agent-reported",
    ],
    [
      "a path the shape doesn't have",
      CONTRACTS + GATE.replace("findings.blocker", "findings.critical"),
      "No property findings.critical",
    ],
    [
      "an evidence requirement in a level 4 file",
      `${CONTRACTS}- gate: CI\n  tool: github\n  operation: pr.merge\n  resource: { kind: repository, match: any }\n  requires:\n    - { evidence: ci, authority: externally-verified, subject: revision }\n  otherwise: deny\n`,
      "Evidence requirements need required_engine_version: 5",
    ],
    [
      "evidence contracts in a level 4 file",
      CONTRACTS.replace("    receipts:", "    evidence: {}\n    receipts:"),
      "Evidence contracts need required_engine_version: 5",
    ],
    [
      "a contract key this engine doesn't enforce",
      CONTRACTS.replace("    receipts:", "    memory: {}\n    receipts:"),
      "memory",
    ],
  ])("%s is refused", (_name, text, message) => {
    const result = compilePolicies([{ name: "a.yaml", text }]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((i) => i.message).join("\n")).toContain(message);
  });
});

describe("gates on valid receipts", { timeout: 60_000 }, () => {
  test("valid receipts meeting where open the gate; invalid and unmet ones keep it closed", async () => {
    const { repo, file } = scratch(CONTRACTS + GATE);
    const s = session(repo, file);
    expect(answer((await s.dispatch("github")).stdout).permissionDecision).toBe(
      "deny",
    );

    await finished(s, { id: "r1", type: "reviewer" }, reviewer("ship", 1));
    await finished(s, { id: "q1", type: "qa" }, qa("PASS"));
    const blocker = answer((await s.dispatch("github")).stdout);
    expect(blocker.permissionDecision).toBe("deny");
    expect(blocker.permissionDecisionReason).toContain(
      "reviewer with ship or ship-with-debt where findings.blocker is 0 and findings.major is at most 2",
    );
    expect(blocker.permissionDecisionReason).toContain(
      "doesn't meet the where conditions",
    );

    // A receipt that breaks its contract has no verdict, however it reads.
    await finished(
      s,
      { id: "r2", type: "reviewer" },
      reviewer("ship").replace("blocker: 0", "blocker: '0'"),
    );
    const invalid = answer((await s.dispatch("github")).stdout);
    expect(invalid.permissionDecisionReason).toContain(
      "its last receipt was invalid (findings.blocker: type)",
    );

    await finished(
      s,
      { id: "r3", type: "reviewer" },
      reviewer("ship-with-debt"),
    );
    expect(answer((await s.dispatch("github")).stdout).permissionDecision).toBe(
      "allow",
    );

    // The latest receipt wins. A later one with a blocker, or invalid,
    // closes the gate the earlier valid one opened, with no work between.
    await finished(s, { id: "r4", type: "reviewer" }, reviewer("ship", 1));
    expect(answer((await s.dispatch("github")).stdout).permissionDecision).toBe(
      "deny",
    );
    await finished(s, { id: "r5", type: "reviewer" }, reviewer("ship"));
    expect(answer((await s.dispatch("github")).stdout).permissionDecision).toBe(
      "allow",
    );
    await finished(
      s,
      { id: "r6", type: "reviewer" },
      reviewer("ship").replace("blocker: 0", "blocker: '0'"),
    );
    expect(answer((await s.dispatch("github")).stdout).permissionDecision).toBe(
      "deny",
    );
    await finished(s, { id: "r7", type: "reviewer" }, reviewer("ship"));

    // Changed work after the receipts closes the gate again.
    await s.start({ id: "d1", type: "dev" });
    expect(answer((await s.dispatch("github")).stdout).permissionDecision).toBe(
      "deny",
    );
  });

  test("a gate that passes never stands in for a missing allow rule", async () => {
    const rules = (CONTRACTS + GATE).replace(
      "- rule: Start any subagent\n  tool: claude-code\n  operation: agent\n  resource: { kind: agent, match: any }\n  effect: allow\n",
      "",
    );
    const { repo, file } = scratch(rules);
    const s = session(repo, file);
    await finished(s, { id: "r1", type: "reviewer" }, reviewer("ship"));
    await finished(s, { id: "q1", type: "qa" }, qa("PASS"));
    const held = answer((await s.dispatch("github")).stdout);
    expect(held.permissionDecision).toBe("deny");
    expect(held.permissionDecisionReason).toContain("no rule covers");
  });

  test("a self-asserted anchor: fresh never replaces the revision the runtime saw", async () => {
    const rules =
      CONTRACTS +
      GATE.replace("      where: {", "      subject: revision\n      where: {");
    const { repo, file } = scratch(rules);
    writeFileSync(join(repo, "a.txt"), "one");
    spawnSync("git", ["add", "."], { cwd: repo });
    spawnSync(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "c"],
      { cwd: repo },
    );
    const s = session(repo, file);
    await finished(s, { id: "r1", type: "reviewer" }, reviewer("ship"));
    await finished(s, { id: "q1", type: "qa" }, qa("PASS"));
    expect(answer((await s.dispatch("github")).stdout).permissionDecision).toBe(
      "allow",
    );

    // Changed outside any hook: only the revision shows it.
    writeFileSync(join(repo, "a.txt"), "two");
    const stale = answer((await s.dispatch("github")).stdout);
    expect(stale.permissionDecision).toBe("deny");
    expect(stale.permissionDecisionReason).toContain(
      "the work changed after its receipt",
    );
  });

  test("a missing receipt and an identity mismatch are recorded with a reason", async () => {
    const { repo, file } = scratch(CONTRACTS + GATE);
    const s = session(repo, file);
    await finished(s, { id: "q1", type: "qa" }, "All good, PASS.");
    await finished(
      s,
      { id: "q2", type: "qa" },
      "RECEIPT dev\nresult: PASS\nissue: x\n",
    );
    const [missing, mismatch] = finishes(repo);
    expect(missing).toMatchObject({
      verdict: null,
      receipt: { state: "missing", via: "stop", value: null },
    });
    expect(mismatch).toMatchObject({
      verdict: null,
      receipt: {
        state: "invalid",
        issues: [{ path: "agent", code: "identity" }],
      },
    });
  });
});

/** A qa step started under rules without contracts (version 2), and `more` rules. */
async function legacyStep(more: string) {
  const { repo, file } = scratch(
    `- required_engine_version: 3\n- rule: Start\n  tool: claude-code\n  operation: agent\n  resource: { kind: agent, match: any }\n  effect: allow\n${more}`,
  );
  const s = session(repo, file);
  const agent = { id: "q1", type: "qa" };
  await s.start(agent);
  return { repo, s, agent };
}

describe("capture through SubagentHandback", { timeout: 60_000 }, () => {
  test("an invalid receipt is refused so the subagent resends; a valid one finishes the step once", async () => {
    const { repo, file } = scratch(CONTRACTS + GATE);
    const s = session(repo, file);
    const agent = { id: "r1", type: "reviewer" };
    await s.start(agent);

    const refused = answer(
      (
        await s.handback(
          agent,
          reviewer("ship").replace("anchor: fresh", "anchor: FRESH"),
        )
      ).stdout,
    );
    expect(refused.permissionDecision).toBe("deny");
    expect(refused.permissionDecisionReason).toContain(
      "your receipt can't be accepted: anchor: expected one of fresh, stale",
    );
    expect(finishes(repo)).toEqual([]);

    expect(
      answer((await s.handback(agent, reviewer("ship"))).stdout)
        .permissionDecision,
    ).toBe("allow");
    // The stop after a hand-back carries no message and records nothing more.
    await s.stop(agent);
    await s.stop(agent, reviewer("fix-first"));
    expect(finishes(repo)).toMatchObject([
      {
        step: "r1",
        verdict: "ship",
        receipt: { state: "valid", via: "handback" },
      },
    ]);
  });

  test("a stop event delivered twice completes the step once", async () => {
    const { repo, file } = scratch(CONTRACTS + GATE);
    const s = session(repo, file);
    const agent = { id: "q1", type: "qa" };
    await finished(s, agent, qa("FAIL"));
    await s.stop(agent, qa("PASS"));
    expect(finishes(repo)).toMatchObject([{ verdict: "fail" }]);
  });

  test("without contracts, a hand-back finishes the step and the stop after it adds nothing", async () => {
    const { repo, s, agent } = await legacyStep(
      "- gate: G\n  tool: claude-code\n  operation: agent\n  resource: { kind: agent, match: exact, value: github }\n  requires: [{ agent: qa, verdict: pass }]\n  otherwise: deny\n",
    );
    // No rule covers the hand-back, so it goes ahead and finishes the step,
    // read by the fixed parser as a stop's message would be.
    expect(
      answer(
        (await s.handback(agent, "```nodrail-receipt\nverdict: pass\n```"))
          .stdout,
      ).permissionDecision,
    ).toBe("allow");
    // Claude Code's stop after a hand-back carries no message: nothing more.
    await s.stop(agent);
    expect(finishes(repo)).toMatchObject([{ verdict: "pass" }]);
    expect(finishes(repo)[0]).not.toHaveProperty("receipt");
    expect(answer((await s.dispatch("github")).stdout).permissionDecision).toBe(
      "allow",
    );
  });

  test("without contracts, stops that carry messages are recorded as before", async () => {
    const { repo, s, agent } = await legacyStep(
      "- budget: B\n  per: run\n  tool_calls: 100\n  otherwise: deny\n",
    );
    await s.stop(agent, "```nodrail-receipt\nverdict: fail\n```");
    await s.stop(agent, "```nodrail-receipt\nverdict: pass\n```");
    expect(finishes(repo)).toMatchObject([
      { verdict: "fail" },
      { verdict: "pass" },
    ]);
  });
});

describe("Copilot steps", { timeout: 60_000 }, () => {
  test("a native subagentStop's response is read as the stop's final message", async () => {
    const { repo, file } = scratch(CONTRACTS + GATE);
    const send = (event: object) =>
      cli(
        ["hook", file, "--host", "copilot"],
        JSON.stringify({ sessionId: "s-1", cwd: repo, ...event }),
      );
    const start = await send({
      agentId: "q1",
      agentType: "qa",
      agentName: "qa",
    });
    expect(start).toMatchObject({ code: 0, stdout: "" });
    await send({
      agentId: "q1",
      agentType: "qa",
      response: qa("PASS"),
      stopReason: "end_turn",
    });
    expect(finishes(repo)).toMatchObject([
      {
        agent: "qa",
        verdict: "pass",
        receipt: { state: "valid", via: "stop" },
      },
    ]);
  });
});

describe("the hook never fails open", () => {
  /** What the guard says and ends with when `work` never finishes in 10 ms. */
  async function pastDeadline(work: () => Promise<number>) {
    const codes: number[] = [];
    const told: string[] = [];
    void guardHook(
      work,
      (text) => told.push(text),
      (code) => codes.push(code),
      10,
    );
    await new Promise((done) => setTimeout(done, 50));
    return { codes, told };
  }

  test("past its deadline a tool call ends with 2", async () => {
    const { codes, told } = await pastDeadline(
      () => new Promise<number>(() => {}),
    );
    expect(codes).toEqual([2]);
    expect(told.join("")).toContain("so this action is blocked");
  });

  test("an error thrown later in a callback blocks the call", async () => {
    const codes: number[] = [];
    const work = guardHook(
      () =>
        new Promise<number>((done) => {
          setTimeout(() => {
            process.emit("uncaughtException", new Error("boom"));
            done(0);
          }, 5);
        }),
      () => {},
      (code) => codes.push(code),
    );
    await work;
    expect(codes).toEqual([2]);
  });

  test("a step event that fails ends with 0, so the subagent can stop", async () => {
    const { codes, told } = await pastDeadline(() => {
      hookIsStep();
      return new Promise<number>(() => {});
    });
    expect(codes).toEqual([0]);
    expect(told.join("")).toContain("the step isn't recorded");
  });
});
