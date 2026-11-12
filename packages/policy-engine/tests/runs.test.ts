// Conformance for gates and budgets: one block per rule in
// docs/runs.md, in the order the rules are stated there.
import { describe, expect, test } from "vitest";
import {
  policyDocument,
  simulate,
  type Descriptor,
  type RunContext,
  type RunEvent,
} from "../src/index";
import { parseReceipt } from "../src/receipts";
import { compilePolicies, renderPolicies } from "../src/yaml";

const now = new Date("2026-11-11T12:00:00.000Z");
const at = now.toISOString();

function compile(text: string) {
  const result = compilePolicies([{ name: "runs.yaml", text }]);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.document;
}

function issues(text: string) {
  const result = compilePolicies([{ name: "runs.yaml", text }]);
  return result.ok ? [] : result.issues.map((issue) => issue.message);
}

const dispatch = (agent: string): Descriptor => ({
  agentId: "local-agent",
  installationId: "local-install",
  toolKey: "agent",
  operationKey: "dispatch",
  resourceKind: "agent",
  resourceId: agent,
  params: {},
});

const shell = (command: string): Descriptor => ({
  agentId: "local-agent",
  installationId: "local-install",
  toolKey: "shell",
  operationKey: command.includes("&&") ? "command.compound" : "command.run",
  resourceKind: "command",
  resourceId: command,
  params: command.includes("&&")
    ? { command, parts: command.split("&&").map((part) => part.trim()) }
    : { command },
});

let counter = 0;
const started = (agent: string, step = `${agent}-${++counter}`): RunEvent => ({
  type: "step.started",
  step,
  agent,
  at,
});
const finished = (
  agent: string,
  verdict: string | null,
  usage: { tokens?: number; usd?: number } = {},
  step = `${agent}-${++counter}`,
): RunEvent => ({
  type: "step.finished",
  step,
  agent,
  at,
  verdict,
  findings: [],
  usage,
});
/** A whole step: started, then finished. */
const ran = (
  agent: string,
  verdict: string | null,
  step = `${agent}-${++counter}`,
): RunEvent[] => [started(agent, step), finished(agent, verdict, {}, step)];
type ActionEvent = Extract<RunEvent, { type: "action" }>;
const action = (agent: string, step: string | null): ActionEvent => ({
  type: "action",
  step,
  agent,
  at,
  tool: "shell",
  operation: "command.run",
  outcome: "allow",
});

const run = (
  events: RunEvent[],
  step: RunContext["step"] = null,
): RunContext => ({ run: "feature/login", step, events });

const GATED = `
- required_engine_version: 3
- list: builders
  items: [dev, infra]
- rule: Dispatch any agent
  tool: agent
  operation: dispatch
  resource: { kind: agent, match: any }
  effect: allow
- rule: Run git
  command: { prefix: git }
  effect: allow
- gate: Review before the pull request
  id: review-before-pr
  tool: agent
  operation: dispatch
  resource: { kind: agent, match: exact, value: github }
  requires:
    - { agent: qa, verdict: pass, since: { list: builders } }
    - { agent: reviewer, verdict: [ship, ship_with_debt], since: [dev, infra] }
  otherwise: require_approval
- gate: Review before a push
  id: review-before-push
  command: { prefix: git push }
  requires:
    - { agent: reviewer, verdict: [SHIP, ship_with_debt], since: { list: builders } }
  otherwise: deny
`;

const decide = (descriptor: Descriptor, context: RunContext | null) =>
  simulate({ document: compile(GATED), descriptor, now, run: context });

const shipped = () => [
  started("dev"),
  finished("dev", "done"),
  ...ran("qa", "pass"),
  ...ran("reviewer", "ship"),
];

describe("1. a gate never allows", () => {
  test("a met gate adds nothing, so with no allow rule the action stays blocked", () => {
    const document = compile(`
- required_engine_version: 3
- gate: Needs QA
  tool: agent
  operation: dispatch
  resource: { kind: agent, match: any }
  requires: [{ agent: qa, verdict: pass }]
  otherwise: deny
`);
    const result = simulate({
      document,
      descriptor: dispatch("github"),
      now,
      run: run(ran("qa", "pass")),
    });
    expect(result.outcome).toBe("none");
    expect(result.gates).toEqual([
      expect.objectContaining({ applies: true, missing: [] }),
    ]);
  });

  test("an unmet gate outranks an allow rule", () => {
    const result = decide(dispatch("github"), run([]));
    expect(result).toMatchObject({
      outcome: "require_approval",
      matchedRuleId: "review-before-pr",
      reason: "gate",
    });
  });

  test("a met gate leaves the rules to decide", () => {
    expect(decide(dispatch("github"), run(shipped())).outcome).toBe("allow");
  });
});

describe("2. a gate matches like a rule", () => {
  test("a gate on one agent leaves other dispatches alone", () => {
    const result = decide(dispatch("qa"), run([]));
    expect(result.outcome).toBe("allow");
    expect(
      result.gates.find((gate) => gate.id === "review-before-pr"),
    ).toMatchObject({
      applies: false,
    });
  });

  test("a command gate uses word boundaries", () => {
    expect(decide(shell("git push origin main"), run([])).outcome).toBe("deny");
    expect(decide(shell("git push"), run([])).outcome).toBe("deny");
    expect(decide(shell("git pushy"), run([])).outcome).toBe("allow");
  });

  test("a command gate sees inside a chain of commands", () => {
    const chained = shell("git add . && git push");
    expect(decide(chained, run([])).outcome).toBe("deny");
    expect(decide(chained, run(shipped())).outcome).toBe("allow");
  });
});

describe("3. when a requirement is met", () => {
  const pr = (events: RunEvent[]) =>
    decide(dispatch("github"), run(events)).outcome;

  test("both steps passed after the last builder", () => {
    expect(pr(shipped())).toBe("allow");
  });

  test("a builder that worked after QA undoes QA", () => {
    expect(
      pr([
        ...ran("qa", "pass"),
        finished("dev", "done"),
        ...ran("reviewer", "ship"),
      ]),
    ).toBe("require_approval");
  });

  test("a builder still running counts as the latest work", () => {
    expect(pr([...shipped(), started("dev")])).toBe("require_approval");
  });

  test("a builder's action after the review counts as work", () => {
    expect(pr([...shipped(), action("infra", "infra-9")])).toBe(
      "require_approval",
    );
  });

  test("another agent's work does not reset the window", () => {
    expect(pr([...shipped(), finished("docs", "done")])).toBe("allow");
  });

  test("the verdict must be one the gate accepts", () => {
    const failed = [
      started("dev"),
      finished("qa", "fail"),
      finished("reviewer", "ship"),
    ];
    expect(pr(failed)).toBe("require_approval");
  });

  test("a step that reported no verdict meets nothing", () => {
    expect(pr([finished("qa", null), finished("reviewer", "ship")])).toBe(
      "require_approval",
    );
  });

  test("a later failing QA does not erase an earlier pass with no build between", () => {
    expect(pr([...shipped(), finished("qa", "fail")])).toBe("allow");
  });

  test("without since, any time in the run counts", () => {
    const document = compile(`
- required_engine_version: 3
- rule: Dispatch
  tool: agent
  operation: dispatch
  resource: { kind: agent, match: any }
  effect: allow
- gate: Planned
  tool: agent
  operation: dispatch
  resource: { kind: agent, match: exact, value: dev }
  requires: [{ agent: pm, verdict: ready }]
  otherwise: deny
`);
    const outcome = (events: RunEvent[]) =>
      simulate({ document, descriptor: dispatch("dev"), now, run: run(events) })
        .outcome;
    expect(outcome([...ran("pm", "ready"), finished("dev", "done")])).toBe(
      "allow",
    );
    expect(outcome([])).toBe("deny");
  });

  test("the explanation names what is missing", () => {
    const result = decide(dispatch("github"), run(ran("qa", "pass")));
    expect(result.explanation).toBe(
      "Gate review-before-pr needs reviewer with ship or ship_with_debt after the last change or dev or infra work.",
    );
  });
});

describe("4. missing history fails closed", () => {
  test("no run at all leaves every requirement unmet", () => {
    expect(decide(dispatch("github"), null).outcome).toBe("require_approval");
    expect(decide(shell("git push"), null).outcome).toBe("deny");
  });

  test("a run that is not a run is refused, not read as empty", () => {
    expect(() =>
      simulate({
        document: compile(GATED),
        descriptor: dispatch("github"),
        now,
        run: { run: "", step: null, events: [] },
      }),
    ).toThrow();
  });
});

const BUDGETS = `
- required_engine_version: 3
- rule: Run anything
  command: { prefix: ls }
  effect: allow
- budget: Builder step
  id: builder-step
  step_agent: dev
  per: step
  tool_calls: 3
  warn_at: 2
  otherwise: require_approval
- budget: Run spend
  id: run-spend
  per: run
  usd: 10
  otherwise: deny
`;

const spend = (context: RunContext) =>
  simulate({
    document: compile(BUDGETS),
    descriptor: shell("ls"),
    now,
    run: context,
  });

describe("6. budgets count what the run recorded", () => {
  const step = { id: "dev-a", agent: "dev" };

  test("the action being decided counts, so a limit of 3 allows the third call", () => {
    const third = spend(
      run([action("dev", "dev-a"), action("dev", "dev-a")], step),
    );
    expect(third.outcome).toBe("allow");
    const fourth = spend(
      run(
        [
          action("dev", "dev-a"),
          action("dev", "dev-a"),
          action("dev", "dev-a"),
        ],
        step,
      ),
    );
    expect(fourth).toMatchObject({
      outcome: "require_approval",
      matchedRuleId: "builder-step",
      reason: "budget",
      explanation: "Budget builder-step is at 4 of 3 tool calls.",
    });
  });

  test("a step budget counts only that step", () => {
    const other = [
      action("dev", "dev-b"),
      action("dev", "dev-b"),
      action("dev", "dev-b"),
    ];
    expect(spend(run(other, step)).outcome).toBe("allow");
  });

  test("a budget for one agent leaves other agents alone", () => {
    const many = Array.from({ length: 5 }, () => action("qa", "qa-a"));
    const result = spend(run(many, { id: "qa-a", agent: "qa" }));
    expect(result.outcome).toBe("allow");
    expect(result.budgets.map((budget) => budget.id)).toEqual(["run-spend"]);
  });

  test("spend adds what finished steps reported", () => {
    expect(spend(run([finished("dev", "done", { usd: 4 })])).outcome).toBe(
      "allow",
    );
    expect(
      spend(
        run([
          finished("dev", "done", { usd: 4 }),
          finished("qa", "pass", { usd: 6 }),
        ]),
      ),
    ).toMatchObject({ outcome: "deny", matchedRuleId: "run-spend" });
  });

  test("with no run, a budget that covers the action holds it", () => {
    const result = simulate({
      document: compile(BUDGETS),
      descriptor: shell("ls"),
      now,
    });
    expect(result).toMatchObject({
      outcome: "deny",
      matchedRuleId: "run-spend",
      reason: "budget",
      explanation:
        "Budget run-spend needs a run to count USD, and this action has none.",
    });
    // The dev step budget doesn't cover an action outside any step.
    expect(result.budgets.map(({ id, state }) => [id, state])).toEqual([
      ["run-spend", "no_run"],
    ]);
  });

  test("with no run, a budget asking for review asks", () => {
    const document = compile(`
- required_engine_version: 3
- rule: Run ls
  command: ls
  effect: allow
- budget: Calls
  id: calls
  per: step
  tool_calls: 5
  otherwise: require_approval
`);
    expect(
      simulate({ document, descriptor: shell("ls"), now, run: null }),
    ).toMatchObject({ outcome: "require_approval", matchedRuleId: "calls" });
  });
});

describe("10. gates and budgets only make the rules stricter", () => {
  const UNMATCHED = `
- required_engine_version: 3
- gate: Review first
  id: review-first
  command: { prefix: git push }
  requires: [{ agent: reviewer, verdict: ship }]
  otherwise: require_approval
- budget: Calls
  id: calls
  per: run
  tool_calls: 1
  otherwise: deny
`;

  test("no rule matched and an unmet gate asking for review stays blocked", () => {
    const result = simulate({
      document: compile(UNMATCHED),
      descriptor: shell("git push"),
      now,
      run: run([]),
    });
    expect(result).toMatchObject({
      outcome: "none",
      reason: "no_matching_rule",
    });
    expect(result.gates[0]?.missing).toHaveLength(1);
  });

  test("no rule matched and a used-up budget that denies is denied", () => {
    const result = simulate({
      document: compile(UNMATCHED),
      descriptor: shell("git push"),
      now,
      run: run([action("main", null)]),
    });
    expect(result).toMatchObject({
      outcome: "deny",
      matchedRuleId: "calls",
      reason: "budget",
      explanation: "Budget calls is at 2 of 1 tool calls.",
    });
  });

  test("an unmet gate that denies beats no rule, and says why", () => {
    const document = compile(
      UNMATCHED.replace("otherwise: require_approval", "otherwise: deny"),
    );
    expect(
      simulate({ document, descriptor: shell("git push"), now, run: run([]) }),
    ).toMatchObject({
      outcome: "deny",
      reason: "gate",
      explanation: "Gate review-first needs reviewer with ship.",
    });
  });
});

describe("11. a step must start and finish after the work", () => {
  const pr = (events: RunEvent[]) =>
    decide(dispatch("github"), run(events)).outcome;

  test("a QA step that started before the builder's last action meets nothing", () => {
    expect(
      pr([
        started("dev", "d1"),
        started("qa", "q1"),
        action("dev", "d1"),
        finished("dev", "done", {}, "d1"),
        finished("qa", "pass", {}, "q1"),
        ...ran("reviewer", "ship"),
      ]),
    ).toBe("require_approval");
  });

  test("a finish with no recorded start meets nothing", () => {
    expect(
      pr([
        ...ran("dev", "done"),
        finished("qa", "pass"),
        ...ran("reviewer", "ship"),
      ]),
    ).toBe("require_approval");
  });
});

describe("12. a change by any other agent is work", () => {
  const change = (
    agent: string,
    step: string | null,
    descriptor: Pick<ActionEvent, "tool" | "operation">,
  ): RunEvent => ({
    ...action(agent, step),
    ...descriptor,
    change: true,
  });
  const looked = (agent: string): RunEvent => ({
    ...action(agent, null),
    change: false,
  });
  const pr = (events: RunEvent[]) =>
    decide(dispatch("github"), run([...shipped(), ...events])).outcome;

  test("the main agent writing a file after the review closes the gate", () => {
    expect(
      pr([change("main", null, { tool: "files", operation: "file.write" })]),
    ).toBe("require_approval");
  });

  test("a general-purpose subagent committing after the review closes the gate", () => {
    expect(
      pr([
        started("general-purpose", "g1"),
        change("general-purpose", "g1", {
          tool: "shell",
          operation: "command.run",
        }),
      ]),
    ).toBe("require_approval");
  });

  test("looking around after the review keeps it", () => {
    expect(pr([looked("main")])).toBe("allow");
  });

  test("an action recorded before changes were recorded is not one", () => {
    expect(pr([action("main", null)])).toBe("allow");
  });

  const reviewed = (reviewerChange: RunEvent) => [
    started("dev"),
    finished("dev", "done"),
    ...ran("qa", "pass"),
    started("reviewer", "r1"),
    reviewerChange,
    finished("reviewer", "ship", {}, "r1"),
  ];

  test("a reviewer running commands to check the work keeps QA's pass", () => {
    const shell = { tool: "shell", operation: "command.run" };
    expect(
      decide(dispatch("github"), run(reviewed(change("reviewer", "r1", shell))))
        .outcome,
    ).toBe("allow");
  });

  test("a reviewer editing a file undoes QA's pass, not its own review", () => {
    const edit = { tool: "files", operation: "file.edit" };
    const result = decide(
      dispatch("github"),
      run(reviewed(change("reviewer", "r1", edit))),
    );
    expect(result.explanation).toBe(
      "Gate review-before-pr needs qa with pass after the last change or dev or infra work.",
    );
  });

  test("without since, a change elsewhere undoes nothing", () => {
    const document = compile(`
- required_engine_version: 3
- rule: Dispatch
  tool: agent
  operation: dispatch
  resource: { kind: agent, match: any }
  effect: allow
- gate: Planned
  tool: agent
  operation: dispatch
  resource: { kind: agent, match: exact, value: dev }
  requires: [{ agent: pm, verdict: ready }]
  otherwise: deny
`);
    const events = [
      ...ran("pm", "ready"),
      change("main", null, { tool: "files", operation: "file.edit" }),
    ];
    expect(
      simulate({ document, descriptor: dispatch("dev"), now, run: run(events) })
        .outcome,
    ).toBe("allow");
  });
});

describe("8. over a budget, and near it", () => {
  test("near the limit warns and changes nothing", () => {
    const result = spend(
      run([action("dev", "dev-a")], { id: "dev-a", agent: "dev" }),
    );
    expect(result.outcome).toBe("allow");
    expect(result.warnings).toEqual([
      "Budget builder-step is at 2 of 3 tool calls.",
    ]);
  });

  test("a deny rule still beats a budget that asks for review", () => {
    const document = compile(`${BUDGETS}
- rule: Never ls secrets
  command: ls secrets
  effect: deny
`);
    const full = Array.from({ length: 3 }, () => action("dev", "dev-a"));
    const result = simulate({
      document,
      descriptor: shell("ls secrets"),
      now,
      run: run(full, { id: "dev-a", agent: "dev" }),
    });
    expect(result).toMatchObject({ outcome: "deny", reason: "explicit_rule" });
  });
});

describe("9. versions", () => {
  test("files without gates or budgets still compile to version 1", () => {
    const document = compile(`
- rule: Run ls
  command: ls
  effect: allow
`);
    expect(document.version).toBe(1);
  });

  test("gates and budgets compile to version 2", () => {
    expect(compile(GATED).version).toBe(2);
    expect(compile(BUDGETS).version).toBe(2);
  });

  test("a version 1 document cannot carry gates", () => {
    const { rules, gates } = compile(GATED) as {
      rules: unknown[];
      gates: unknown[];
    };
    expect(policyDocument.safeParse({ version: 1, rules, gates }).success).toBe(
      false,
    );
  });

  test("a file asking for a newer engine is refused", () => {
    expect(issues("- required_engine_version: 4\n")).toEqual([
      "This file needs engine version 4; this is 3.",
    ]);
  });
});

describe("5 and 7. names, one limit per budget, and compiling", () => {
  test("names, verdicts and since lists are compared in lowercase", () => {
    const document = compile(GATED);
    if (document.version !== 2) throw new Error("expected version 2");
    const push = document.gates.find(
      (gate) => gate.id === "review-before-push",
    );
    expect(push?.requires).toEqual([
      {
        agent: "reviewer",
        verdicts: ["ship", "ship_with_debt"],
        since: ["dev", "infra"],
      },
    ]);
  });

  test("a command gate becomes the same two entries a command rule does", () => {
    const document = compile(GATED);
    if (document.version !== 2) throw new Error("expected version 2");
    expect(
      document.gates
        .filter((gate) => gate.id.startsWith("review-before-push"))
        .map((gate) => gate.resource),
    ).toEqual([
      { kind: "command", match: "exact", value: "git push" },
      { kind: "command", match: "prefix", value: "git push " },
    ]);
  });

  test.each([
    [
      "a gate without requirements",
      "- gate: g\n  command: ls\n  otherwise: deny\n",
      'Gate "g" needs requires.',
    ],
    [
      "a gate that would allow",
      "- gate: g\n  command: ls\n  requires: [{ agent: qa, verdict: pass }]\n  otherwise: allow\n",
      "otherwise",
    ],
    [
      "a gate with an unknown since list",
      "- gate: g\n  command: ls\n  requires: [{ agent: qa, verdict: pass, since: { list: nope } }]\n  otherwise: deny\n",
      'Unknown list "nope".',
    ],
    [
      "a since that names a list as if it were an agent",
      "- list: builders\n  items: [dev]\n- gate: g\n  command: ls\n  requires: [{ agent: qa, verdict: pass, since: builders }]\n  otherwise: deny\n",
      "Write since: { list: builders }",
    ],
    [
      "a budget with two limits",
      "- budget: b\n  per: run\n  usd: 1\n  tokens: 5\n  otherwise: deny\n",
      "use one budget per limit",
    ],
    [
      "a budget on spend per step",
      "- budget: b\n  per: step\n  usd: 1\n  otherwise: deny\n",
      "Only tool_calls can be limited per step",
    ],
    [
      "a warning at the limit",
      "- budget: b\n  per: run\n  tool_calls: 5\n  warn_at: 5\n  otherwise: deny\n",
      "warn_at must be below the limit",
    ],
    [
      "a gate sharing a rule's id",
      "- rule: r\n  id: same\n  command: ls\n  effect: allow\n- gate: g\n  id: same\n  command: ls\n  requires: [{ agent: qa, verdict: pass }]\n  otherwise: deny\n",
      "ids must be unique",
    ],
  ])("refuses %s", (_, text, message) => {
    expect(issues(text).join("\n")).toContain(message);
  });

  test("a gate that is switched off compiles to nothing and keeps its list in use", () => {
    const result = compilePolicies([
      {
        name: "off.yaml",
        text: `
- list: builders
  items: [dev]
- rule: Run ls
  command: ls
  effect: allow
- gate: Off
  command: ls
  requires: [{ agent: qa, verdict: pass, since: { list: builders } }]
  otherwise: deny
  enabled: false
`,
      },
    ]);
    expect(result.ok && result.document.version).toBe(1);
    expect(result.warnings).toEqual([]);
  });
});

describe("exporting", () => {
  test.each([
    ["gates", GATED],
    ["budgets", BUDGETS],
  ])("rendering %s compiles back to the same document", (_, text) => {
    const document = compile(text);
    expect(compile(renderPolicies(document))).toEqual(document);
  });
});

describe("receipts", () => {
  const fence = (body: string) => "```nodrail-receipt\n" + body + "\n```";

  test("a receipt that ends the message is read", () => {
    expect(
      parseReceipt(
        `All checks ran.\n\n${fence("verdict: PASS\nfindings: [Correctness, scope drift]\nusd: 0.42\ntokens: 1200")}\n`,
      ),
    ).toEqual({
      verdict: "pass",
      findings: ["correctness", "scope_drift"],
      usage: { usd: 0.42, tokens: 1200 },
    });
  });

  test("a receipt followed by more text is only quoted, so it does not count", () => {
    expect(
      parseReceipt(`${fence("verdict: pass")}\nThen I changed the code.`),
    ).toBeNull();
  });

  test("the last receipt is the one that counts", () => {
    const message = `Example:\n${fence("verdict: pass")}\nMine:\n${fence("verdict: fail")}`;
    expect(parseReceipt(message)?.verdict).toBe("fail");
  });

  test("a receipt cannot say who ran", () => {
    expect(parseReceipt(fence("agent: qa\nverdict: pass"))).toEqual({
      verdict: "pass",
      findings: [],
      usage: {},
    });
  });

  test("a verdict that is not a word is no verdict", () => {
    expect(parseReceipt(fence("verdict: '!!'"))?.verdict).toBeNull();
    expect(parseReceipt(fence("verdict: [pass]"))?.verdict).toBeNull();
  });

  test("broken YAML, negative usage and no receipt are all nothing", () => {
    expect(parseReceipt(fence("verdict: [unclosed"))).toBeNull();
    expect(parseReceipt(fence("verdict: pass\nusd: -1"))).toBeNull();
    expect(parseReceipt("Done, all good.")).toBeNull();
  });
});
