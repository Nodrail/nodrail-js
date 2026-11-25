// Receipts read against their declared contract: the
// fenced block with nesting, the flat header bridge on a team's real
// vocabularies, and the one strict validator behind both.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { receiptText } from "../src/hook-runs";
import {
  compileContracts,
  projectValue,
  readContractReceipt,
  receiptContracts,
  validateValue,
  type ReceiptContract,
} from "../src/shapes/index";
import { anyHeader, readHeaderBlock } from "../src/shapes/values";

/** Each agent's receipt contract from a workspace's declarations. */
function contracts(manifest: unknown, agents: Record<string, string>) {
  const result = compileContracts({
    manifest,
    resources: Object.entries(agents).map(([name, receipt]) => ({
      apiVersion: "nodrail.com/v1alpha1",
      kind: "Agent",
      metadata: { name },
      spec: { receipt },
    })),
  });
  expect(result.issues).toEqual([]);
  return receiptContracts(result.contracts!);
}

const header = (aliases: Record<string, string>, modePrefix = false) => ({
  format: "header",
  header: { title: "RECEIPT {agent}", aliases, mode_prefix: modePrefix },
});

// A team's agents, as their receipts read today (agents/*.md).
const TEAM = contracts(
  {
    shapes: {
      reviewer: {
        properties: {
          verdict: {
            values: ["ship", "ship-with-debt", "fix-first", "unassessable"],
            role: "verdict",
          },
          issue: { type: "string", max: 100 },
          lesson: { type: "string", max: 300, optional: true },
          categories: {
            role: "findings",
            type: "list",
            optional: true,
            of: { values: ["correctness", "scope-drift", "tests", "security"] },
          },
          anchor: { values: ["fresh", "stale"] },
        },
      },
      dev: {
        properties: {
          verdict: { values: ["done", "partial", "blocked"], role: "verdict" },
          issue: { type: "string", max: 100 },
        },
      },
      tester: {
        properties: {
          verdict: {
            values: ["done", "partial", "blocked", "code-defect"],
            role: "verdict",
          },
          issue: { type: "string", max: 100 },
        },
      },
      qa: {
        properties: {
          verdict: { values: ["pass", "fail", "blocked"], role: "verdict" },
          issue: { type: "string", max: 100 },
          screenshots: { type: "integer", min: 0, optional: true },
        },
      },
      observer: {
        properties: {
          verdict: {
            values: ["planned", "gap", "ready", "blockers", "healthy"],
            role: "verdict",
          },
          mode: { values: ["plan", "verify", "release"] },
        },
      },
    },
    receipts: {
      reviewer: { shape: "reviewer", ...header({ result: "verdict" }) },
      dev: { shape: "dev", ...header({ result: "verdict" }) },
      tester: { shape: "tester", ...header({ result: "verdict" }) },
      qa: { shape: "qa", ...header({ result: "verdict" }) },
      observer: { shape: "observer", ...header({ result: "verdict" }, true) },
    },
  },
  {
    reviewer: "reviewer",
    dev: "dev",
    tester: "tester",
    qa: "qa",
    observer: "observer",
  },
);

const read = (agent: string, message: string, dispatched = agent) =>
  readContractReceipt(message, TEAM[agent]!, dispatched);

const REVIEWER = `I read the diff and ran the suite.

\`\`\`
RECEIPT reviewer
result: SHIP-WITH-DEBT
issue: ENG-123
budget: 14/30
lesson: none
recall: 2 queried (receipts) · 1 hook hits acted / 0 ignored (n/a)
findings: 0 blocker / 1 major / 2 minor / 1 debt
categories: correctness 2 · scope-drift 1
anchor: FRESH
carry-forward: 0
\`\`\``;

describe("the header bridge on a team's receipts", () => {
  test("the reviewer's real receipt maps to one typed value", () => {
    expect(read("reviewer", REVIEWER)).toEqual({
      state: "valid",
      format: "header",
      verdict: "ship-with-debt",
      value: {
        verdict: "ship-with-debt",
        issue: "ENG-123",
        lesson: "none",
        categories: ["correctness", "scope-drift"],
        anchor: "fresh",
      },
      findings: 2,
      usage: {},
    });
  });

  test.each([
    ["reviewer", "SHIP", "ship"],
    ["reviewer", "FIX-FIRST.", "fix-first"],
    ["reviewer", "UNASSESSABLE (the diff was empty)", "unassessable"],
    ["dev", "DONE", "done"],
    ["dev", "PARTIAL — two ACs left", "partial"],
    ["dev", "BLOCKED (claim-false: the column exists)", "blocked"],
    ["tester", "CODE-DEFECT", "code-defect"],
    ["qa", "PASS", "pass"],
    ["qa", "fail;", "fail"],
  ])("%s result: %s reads as %s", (agent, said, verdict) => {
    const extra = agent === "reviewer" ? "\nanchor: stale" : "";
    const message = `Report.\n\nRECEIPT ${agent}\nresult: ${said}\nissue: ENG-1${extra}\n`;
    expect(read(agent, message)).toMatchObject({ state: "valid", verdict });
  });

  test("the observer's verdict comes after its mode prefix", () => {
    const message =
      "**RECEIPT observer**\nresult: plan: PLANNED · release: READY · verify: HEALTHY\nmode: plan\nverdict: planned\n";
    expect(read("observer", message)).toMatchObject({
      state: "valid",
      verdict: "planned",
      value: { verdict: "planned", mode: "plan" },
    });
  });

  test("without mode_prefix the mode is the first word, and no verdict", () => {
    const message = "RECEIPT dev\nresult: plan: DONE\nissue: x\n";
    expect(read("dev", message)).toMatchObject({
      state: "invalid",
      issues: [{ path: "verdict", code: "enum" }],
    });
  });

  test("bold header, bullets and unknown lines are tolerated", () => {
    const message =
      "Done.\n\n**RECEIPT qa**\n- result: PASS\n- budget used: 4/30 tool calls\n- issue: ENG-2\nscreenshots: 3\n";
    expect(read("qa", message)).toMatchObject({
      state: "valid",
      value: { verdict: "pass", issue: "ENG-2", screenshots: 3 },
    });
  });

  test("a repeated closing header is ignored", () => {
    const message = "RECEIPT qa\nresult: PASS\nissue: ENG-3\nRECEIPT qa\n```\n";
    expect(read("qa", message)).toMatchObject({ state: "valid" });
  });

  test("a receipt quoted mid-message is no receipt", () => {
    const message =
      "The contract is:\nRECEIPT qa\nresult: PASS\nissue: x\nNow I am running it.";
    expect(read("qa", message)).toMatchObject({ state: "missing" });
  });

  test("only the final block counts", () => {
    const message =
      "RECEIPT qa\nresult: FAIL\nissue: a\n\nRetried.\n\nRECEIPT qa\nresult: PASS\nissue: b\n";
    expect(read("qa", message)).toMatchObject({
      state: "valid",
      verdict: "pass",
    });
  });

  test("a block over 8 KiB is invalid for its size, and gives no verdict", () => {
    const message = `RECEIPT qa\nresult: PASS\nissue: x\n${"note: y\n".repeat(1200)}`;
    expect(read("qa", message)).toMatchObject({
      state: "invalid",
      issues: [{ path: "(value)", code: "size" }],
    });
  });

  test("another agent's receipt is invalid, not a verdict", () => {
    const message = "RECEIPT reviewer\nresult: SHIP\nissue: x\nanchor: fresh\n";
    expect(read("reviewer", message, "dev")).toMatchObject({
      state: "invalid",
      issues: [{ path: "agent", code: "identity" }],
    });
  });

  test("an unknown verdict word or a missing mapped field stays invalid", () => {
    expect(read("qa", "RECEIPT qa\nresult: GREEN\nissue: x\n")).toMatchObject({
      state: "invalid",
      issues: [{ path: "verdict", code: "enum" }],
    });
    expect(read("qa", "RECEIPT qa\nresult: PASS\n")).toMatchObject({
      state: "invalid",
      issues: [{ path: "issue", code: "required" }],
    });
  });

  test("a mapped field given twice is refused", () => {
    expect(
      read("qa", "RECEIPT qa\nresult: PASS\nissue: a\nissue: b\n"),
    ).toMatchObject({
      state: "invalid",
      issues: [{ path: "issue", code: "duplicate" }],
    });
  });

  test("a header shape takes comma-separated categories too", () => {
    const message =
      "RECEIPT reviewer\nresult: FIX-FIRST\nissue: x\ncategories: correctness, tests\nanchor: stale\n";
    expect(read("reviewer", message)).toMatchObject({
      value: { categories: ["correctness", "tests"] },
    });
  });

  test("an integer line is a number only when written as one", () => {
    expect(
      read("qa", "RECEIPT qa\nresult: PASS\nissue: x\nscreenshots: three\n"),
    ).toMatchObject({
      state: "invalid",
      issues: [{ path: "screenshots", code: "type" }],
    });
  });
});

const REVIEWER_FENCED = contracts(
  {
    shapes: {
      result: {
        properties: {
          verdict: { values: ["ship", "fix-first"], role: "verdict" },
          findings: {
            role: "findings",
            properties: {
              blocker: { type: "integer", min: 0 },
              major: { type: "integer", min: 0 },
            },
          },
          tests_passed: { type: "boolean" },
          note: { type: "string", min: 0, max: 50 },
          usage: {
            role: "usage",
            optional: true,
            properties: { tokens: { type: "integer", min: 0 } },
          },
        },
      },
    },
    receipts: { reviewer: { shape: "result" } },
  },
  { reviewer: "reviewer" },
).reviewer!;

const fenced = (body: string) =>
  `Report.\n\n\`\`\`nodrail-receipt\n${body}\n\`\`\`\n`;
const readFenced = (body: string, agent = "reviewer") =>
  readContractReceipt(fenced(body), REVIEWER_FENCED, agent);

describe("fenced receipts with nesting", () => {
  test("a nested receipt validates, agent taken out as identity", () => {
    expect(
      readFenced(
        "agent: reviewer\nverdict: ship\nfindings: { blocker: 0, major: 2 }\ntests_passed: false\nnote: ''\nusage: { tokens: 10 }",
      ),
    ).toEqual({
      state: "valid",
      format: "fenced",
      verdict: "ship",
      value: {
        verdict: "ship",
        findings: { blocker: 0, major: 2 },
        tests_passed: false,
        note: "",
        usage: { tokens: 10 },
      },
      findings: 2,
      usage: { tokens: 10 },
    });
  });

  test("false, 0 and empty are values; their quoted forms are not", () => {
    expect(
      readFenced(
        "verdict: ship\nfindings: { blocker: '0', major: 0 }\ntests_passed: 'false'\nnote: ''",
      ),
    ).toMatchObject({
      state: "invalid",
      issues: [
        { path: "findings.blocker", code: "type" },
        { path: "tests_passed", code: "type" },
      ],
    });
  });

  test("unknown, required and nested errors name a path, never a value", () => {
    const reading = readFenced(
      "verdict: ship\nfindings: { blocker: 0, minor: 1 }\nsecret: hunter2\nnote: x",
    );
    expect(reading).toMatchObject({ state: "invalid" });
    if (reading.state === "valid") throw new Error("expected invalid");
    expect(reading.issues).toEqual(
      expect.arrayContaining([
        { path: "findings.minor", code: "unknown" },
        { path: "findings.major", code: "required" },
        { path: "secret", code: "unknown" },
        { path: "tests_passed", code: "required" },
      ]),
    );
    expect(reading.reason).not.toContain("hunter2");
  });

  test("identity mismatch, bad YAML and duplicate keys are invalid", () => {
    expect(readFenced("agent: dev\nverdict: ship")).toMatchObject({
      state: "invalid",
      issues: [{ path: "agent", code: "identity" }],
    });
    expect(readFenced("verdict: [ship")).toMatchObject({ state: "invalid" });
    expect(readFenced("verdict: ship\nverdict: fix-first")).toMatchObject({
      state: "invalid",
    });
  });

  test("a block that doesn't end the message is missing, never read from prose", () => {
    const message = `${fenced("verdict: ship")}\nThen I changed it. verdict: ship`;
    expect(
      readContractReceipt(message, REVIEWER_FENCED, "reviewer"),
    ).toMatchObject({ state: "missing" });
  });

  test("there is no fallback from one format to the other", () => {
    const message = "RECEIPT reviewer\nresult: SHIP\n";
    expect(
      readContractReceipt(message, REVIEWER_FENCED, "reviewer"),
    ).toMatchObject({ state: "missing" });
  });
});

describe("findings counts on a header line", () => {
  const SEVERITIES = ["blocker", "major", "minor", "debt"];
  const verdict = {
    values: ["ship", "ship-with-debt", "fix-first"],
    role: "verdict",
  };
  /** A header reviewer whose findings are `findings`. */
  const reviewerWith = (findings: unknown) =>
    contracts(
      {
        shapes: { rv: { properties: { verdict, findings } } },
        receipts: {
          reviewer: { shape: "rv", ...header({ result: "verdict" }) },
        },
      },
      { reviewer: "reviewer" },
    ).reviewer!;
  const asList = reviewerWith({
    role: "findings",
    type: "list",
    optional: true,
    of: { values: SEVERITIES },
  });
  const asCounts = reviewerWith({
    role: "findings",
    properties: Object.fromEntries(
      SEVERITIES.map((name) => [name, { type: "integer", min: 0 }]),
    ),
  });
  const line = (findings: string) =>
    `Done.\n\nRECEIPT reviewer\nresult: SHIP\nfindings: ${findings}\n`;

  test("a list keeps only the categories counted above 0", () => {
    // The team's reviewer line: four categories, one of them found.
    expect(
      readContractReceipt(
        line("0 blocker / 1 major / 0 minor / 0 debt"),
        asList,
        "reviewer",
      ),
    ).toMatchObject({ state: "valid", value: { findings: ["major"] } });
    expect(
      readContractReceipt(line("major 2 · debt 1"), asList, "reviewer"),
    ).toMatchObject({ findings: 2 });
    expect(
      readContractReceipt(line("minor, debt"), asList, "reviewer"),
    ).toMatchObject({ findings: 2 });
  });

  test("an object of counts takes each count, so where can read one", () => {
    expect(
      readContractReceipt(
        line("0 blocker / 1 major / 0 minor / 2 debt"),
        asCounts,
        "reviewer",
      ),
    ).toMatchObject({
      state: "valid",
      value: { findings: { blocker: 0, major: 1, minor: 0, debt: 2 } },
      findings: 3,
    });
    expect(
      readContractReceipt(line("none"), asCounts, "reviewer"),
    ).toMatchObject({
      state: "valid",
      value: { findings: { blocker: 0, major: 0, minor: 0, debt: 0 } },
    });
    // A category left out, or one with no count, is invalid: never guessed.
    expect(
      readContractReceipt(line("1 major"), asCounts, "reviewer"),
    ).toMatchObject({ state: "invalid" });
    expect(
      readContractReceipt(line("major, minor"), asCounts, "reviewer"),
    ).toMatchObject({ state: "invalid" });
  });

  test("a header object of anything but integer counts still nests", () => {
    const result = compileContracts({
      manifest: {
        shapes: {
          rv: {
            properties: {
              verdict,
              detail: { properties: { a: { type: "integer" } } },
            },
          },
        },
        receipts: { reviewer: { shape: "rv", ...header({}) } },
      },
    });
    expect(result.issues.map((issue) => issue.code)).toContain(
      "header-nesting",
    );
  });
});

describe("the text a Cloud hook sends on", () => {
  test("the fenced block, else the header block naming the dispatched agent", () => {
    expect(receiptText(fenced("verdict: ship"), "reviewer")).toBe(
      "```nodrail-receipt\nverdict: ship\n```\n",
    );
    expect(receiptText(REVIEWER, "reviewer")).toBe(
      REVIEWER.slice(REVIEWER.indexOf("RECEIPT")),
    );
    expect(receiptText(REVIEWER, "dev")).toBeNull();
    expect(receiptText("no receipt", "dev")).toBeNull();
  });

  test("any title the grammar allows, joined to the agent or not", () => {
    for (const title of [
      "RECEIPT qa",
      "RECEIPT-qa",
      "RECEIPT_qa",
      "**RECEIPT-qa**",
      "QA RECEIPT qa",
      "RECEIPT QA",
    ]) {
      const block = `${title}\nresult: PASS\nissue: ENG-1`;
      expect(receiptText(`Checked.\n\n${block}\n`, "qa"), title).toBe(block);
    }
    // Another agent's block, or one only partly naming the agent, isn't sent.
    expect(receiptText("RECEIPT-dev\nresult: PASS\n", "qa")).toBeNull();
    expect(receiptText("RECEIPT-team-qa\nresult: PASS\n", "qa")).toBeNull();
    expect(
      receiptText("RECEIPT-team-qa\nresult: PASS\n", "team-qa"),
    ).not.toBeNull();
    // Lowercase prose before the agent is no title.
    expect(receiptText("receipt-qa\nresult: PASS\n", "qa")).toBeNull();
  });

  test("Cloud then reads a joined title with the configured one", () => {
    const contract: ReceiptContract = {
      ...TEAM.qa!,
      header: { ...TEAM.qa!.header!, title: "RECEIPT-{agent}" },
    };
    const text = receiptText(
      "Checked.\n\nRECEIPT-qa\nresult: PASS\nissue: ENG-1\n",
      "qa",
    );
    expect(text).not.toBeNull();
    expect(readContractReceipt(text!, contract, "qa").state).not.toBe(
      "missing",
    );
  });
});

describe("boundaries", () => {
  const contract: ReceiptContract = TEAM.qa!;

  test("whatever an agent writes, reading never throws and stays bounded", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 4000 }), (tail) => {
        const message = `RECEIPT qa\nresult: PASS\n${tail}`;
        const reading = readContractReceipt(message, contract, "qa");
        expect(["valid", "invalid", "missing"]).toContain(reading.state);
        const block = readHeaderBlock(message, anyHeader);
        if (block) expect(block.text.length).toBeLessThanOrEqual(8192);
      }),
    );
  });

  test("strings never pass as integers or booleans, numbers never as strings", () => {
    const shape = REVIEWER_FENCED.shape;
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1000 }), fc.boolean(), (n, b) => {
        const base = {
          verdict: "ship",
          findings: { blocker: n, major: 0 },
          tests_passed: b,
          note: "",
        };
        expect(validateValue(shape, base)).toEqual([]);
        expect(
          validateValue(shape, {
            ...base,
            findings: { blocker: String(n), major: 0 },
          }).map((i) => i.code),
        ).toEqual(["type"]);
        expect(
          validateValue(shape, { ...base, tests_passed: String(b) }).map(
            (i) => i.code,
          ),
        ).toEqual(["type"]);
        expect(
          validateValue(shape, { ...base, note: n }).map((i) => i.code),
        ).toEqual(["type"]);
      }),
    );
  });

  test("200,000 characters before a header take no time", () => {
    const message = `${"RECEIPT qa\nx\n".repeat(20_000)}RECEIPT qa\nresult: PASS\nissue: x\n`;
    const started = performance.now();
    expect(readContractReceipt(message, contract, "qa").state).toBe("valid");
    expect(performance.now() - started).toBeLessThan(200);
  });
});

describe("what Cloud sees of a hidden value", () => {
  test("the withheld paths are the contract's, whatever a receipt says", () => {
    const result = compileContracts({
      manifest: {
        shapes: {
          r: {
            properties: {
              verdict: { values: ["done"], role: "verdict" },
              note: { type: "string", optional: true },
              token: {
                type: "string",
                optional: true,
                classification: "secret",
              },
            },
          },
        },
      },
    });
    const { projection, shape } = result.contracts!.shapes.r!;
    expect(projection.withheld).toEqual(["note", "token"]);
    const filled = { verdict: "done", note: "private", token: "s3cr3t" };
    const empty = { verdict: "done" };
    expect(validateValue(shape, filled)).toEqual([]);
    // Populated or not, a hidden optional value projects the same.
    expect(projectValue(projection, filled)).toEqual(
      projectValue(projection, empty),
    );
  });
});

describe("the contract-values entry", () => {
  test("has no dependencies at all", () => {
    const source = readFileSync(
      join(import.meta.dirname, "../src/shapes/values.ts"),
      "utf8",
    );
    for (const [, target = ""] of source.matchAll(/from "([^"]+)"/g))
      expect(target).toMatch(
        /^\.\/(validate|limits|types|receipt-header|receipt-values|inputs)\.ts$/,
      );
    const inputs = readFileSync(
      join(import.meta.dirname, "../src/shapes/inputs.ts"),
      "utf8",
    );
    for (const [, target = ""] of inputs.matchAll(/from "([^"]+)"/g))
      expect(target).toMatch(
        /^\.\/(validate|limits|types|receipt-values)\.ts$/,
      );
  });
});
