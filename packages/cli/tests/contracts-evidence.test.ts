// Evidence declared once, in nodrail.yaml, like shapes and receipts:
// the generated contracts entry carries it at engine level 5, a rule file's
// own evidence is refused, and a project without evidence keeps the very
// entry it had (fixtures/contracts-source/, written before evidence was read
// from nodrail.yaml). `contracts explain evidence:<name>` reads it from
// either place.
import { describe, expect, test } from "vitest";
import { parse } from "yaml";
import {
  fileOf,
  hookDocument,
  locked,
  planFor,
  project,
  RESOURCES,
} from "./support/setup-project.ts";

const api = "apiVersion: nodrail.com/v1alpha1";

const SHAPES = `shapes:
  reviewer-result:
    properties:
      verdict: { values: [ship, fix-first], role: verdict }
      issue: { type: string, max: 100 }
  brief-shape:
    properties:
      issue: { type: string, max: 20 }
receipts:
  reviewer: { shape: reviewer-result }
`;

const CI = `  ci-result:
    properties:
      status: { values: [passed, failed], report: true }
`;

const EVIDENCE = `evidence:
  ci-tests:
    shape: ci-result
    producers: [{ class: runtime-observed }]
    subject: revision
`;

const AGENTS = [
  `${api}
kind: Agent
metadata: { name: lead }
spec:
  instructions: ./lead.md
  brief: brief-shape`,
  `${api}\nkind: Agent\nmetadata: { name: publisher }\nspec: { receipt: reviewer }`,
  `${api}\nkind: Agent\nmetadata: { name: loner }`,
].join("\n---\n");

const POLICY = `- required_engine_version: 4
- rule: Read anything
  tool: files
  operation: file.read
  resource: { kind: file, match: any }
  effect: allow
- rule: Push
  command: { prefix: git push }
  effect: allow
- gate: Reviewed before a push
  id: reviewed
  command: { prefix: git push }
  requires:
    - { agent: publisher, verdict: ship }
  otherwise: deny
`;

const TESTED = `- required_engine_version: 5
- gate: Tested before a push
  id: tested
  command: { prefix: git push }
  requires:
    - { evidence: ci-tests, authority: runtime-observed, subject: revision, where: { status: passed } }
  otherwise: deny
`;

/** The gate's file with its own contracts entry, as a rule file can declare one. */
const OWN_CONTRACTS = `- required_engine_version: 5
- contracts:
    shapes:
${CI.replace(/^/gm, "    ").trimEnd()}
${EVIDENCE.replace(/^/gm, "    ").trimEnd()}
${TESTED.split("\n").slice(1).join("\n")}`;

const manifest = (contracts: string) =>
  `${RESOURCES["nodrail.yaml"].replace(
    "  - ./policies/base.yaml\n",
    "  - ./policies/base.yaml\n  - ./policies/tested.yaml\n",
  )}${contracts}`;

/** Receipts and a brief, and no evidence: the project golden-tested below. */
const WITHOUT = {
  ...RESOURCES,
  "resources/agents.yaml": AGENTS,
  "policies/base.yaml": POLICY,
  "nodrail.yaml": `${RESOURCES["nodrail.yaml"]}${SHAPES}`,
};

/** The same project with evidence in nodrail.yaml and a gate reading it. */
const WITH = {
  ...WITHOUT,
  "policies/tested.yaml": TESTED,
  "nodrail.yaml": manifest(
    `${SHAPES.replace("receipts:", `${CI}receipts:`)}${EVIDENCE}`,
  ),
};

const effective = (p: ReturnType<typeof project>) =>
  fileOf(planFor(p, "claude-code"), ".nodrail/effective.yaml");

describe("a project without evidence", () => {
  test("keeps its lock and contracts entry byte for byte", async () => {
    const p = await locked(WITHOUT);
    await expect(p.read("nodrail.lock.yaml")).toMatchFileSnapshot(
      "./fixtures/contracts-source/nodrail.lock.yaml",
    );
    await expect(effective(p)).toMatchFileSnapshot(
      "./fixtures/contracts-source/effective.yaml",
    );
  });
});

describe("evidence in nodrail.yaml", () => {
  test("the contracts entry carries it at level 5, and the gate reads it", async () => {
    const p = await locked(WITH);
    const text = effective(p);
    const items = parse(text) as Record<string, unknown>[];
    expect(items[0]).toEqual({ required_engine_version: 5 });
    const contracts = (items[1] as { contracts: Record<string, unknown> })
      .contracts;
    expect(contracts.evidence).toEqual({
      "ci-tests": {
        shape: "ci-result",
        producers: [{ class: "runtime-observed" }],
        subject: "revision",
      },
    });
    expect(Object.keys(contracts.shapes as object)).toEqual([
      "reviewer-result",
      "brief-shape",
      "ci-result",
    ]);
    const document = hookDocument(text);
    expect(document.version).toBe(4);
    expect(Object.keys(document.evidence)).toEqual(["ci-tests"]);
    const lock = parse(p.read("nodrail.lock.yaml"));
    expect(document.evidence["ci-tests"].contract).toBe(
      lock.contracts.shapes["ci-result"].contract,
    );
  });

  test("plan lists each gate once, by its declared id", async () => {
    const p = await locked(WITH);
    const lines = planFor(p, "claude-code").accountable.evidence;
    expect(lines.map((line) => line.gate)).toEqual(["tested"]);
    const plan = await p.run("plan");
    expect(plan.out).not.toContain("-args");
  });

  test("a rule file's own evidence is refused: declare it once", async () => {
    const p = project({
      ...WITHOUT,
      "policies/tested.yaml": OWN_CONTRACTS,
      "nodrail.yaml": manifest(SHAPES),
    });
    const lock = await p.run("policy", "lock");
    expect(lock.code).toBe(1);
    expect(lock.err).toContain(
      "policies/tested.yaml declares a contracts entry, and nodrail.yaml declares contracts too: declare them once, in nodrail.yaml.",
    );
  });

  test("an unknown key next to it is named", async () => {
    const p = project({
      ...WITH,
      "nodrail.yaml": `${WITH["nodrail.yaml"]}evidense: {}\n`,
    });
    const lock = await p.run("policy", "lock");
    expect(lock.code).toBe(1);
    expect(lock.err).toContain(
      "The manifest's fields are not valid: evidense: unknown key",
    );
  });
});

describe("contracts explain evidence:<name>", () => {
  const expected = [
    "evidence:ci-tests (S05, enforced by the hook, engine level 5): evidence",
    "  Producers: runtime-observed",
    "  Subject: revision",
    '    gate "Tested before a push": authority runtime-observed; status is passed',
  ];

  const explains = async (p: ReturnType<typeof project>) => {
    const { code, out } = await p.run(
      "contracts",
      "explain",
      "evidence:ci-tests",
    );
    expect(code).toBe(0);
    for (const line of expected) expect(out).toContain(line);
  };

  test("from nodrail.yaml", async () => {
    await explains(await locked(WITH));
  });

  test("from a rule file's contracts entry, when nodrail.yaml declares none", async () => {
    const p = await locked({
      ...RESOURCES,
      "policies/tested.yaml": OWN_CONTRACTS,
      "nodrail.yaml": manifest(""),
    });
    await explains(p);
  });
});
