// Declared contracts in a project (preview): accepted through the engine's
// compiler, written into generated agent files as one marked section,
// rendered, validated and explained offline, locked, and compared.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, test } from "vitest";
import {
  compileContracts,
  validateValue,
  type CompiledContracts,
  type ResolvedProperty,
  type ResolvedShape,
} from "../src/contracts/engine.ts";
import { contractChanges, lockedContracts } from "../src/contracts/changes.ts";
import {
  exampleOf,
  exampleValue,
  receiptSection,
  SECTION_BEGIN,
  SECTION_END,
} from "../src/contracts/render.ts";
import {
  fileOf,
  leadFiles,
  locked,
  planFor,
  project,
  RESOURCES,
} from "./support/setup-project.ts";

const api = "apiVersion: nodrail.com/v1alpha1";

const SHAPES = `shapes:
  result-base:
    for: What every agent reports
    properties:
      verdict: { values: [done, partial, blocked], role: verdict }
      issue: { type: string, max: 100, for: "Issue id from the brief, or none" }
      lesson: { type: string, max: 300, optional: true, for: "A useful lesson" }
  reviewer-result:
    extends: result-base
    properties:
      verdict: { values: [ship, ship-with-debt, fix-first], role: verdict }
      findings:
        role: findings
        report: true
        properties:
          blocker: { type: integer, min: 0 }
          major: { type: integer, min: 0 }
      anchor: { values: [fresh, stale], for: "Your assessment; runtime verifies freshness independently" }
      due: { type: date, min: "2027-01-01", optional: true }
  developer-result:
    properties:
      result: { values: [done, partial, blocked], role: verdict }
      categories: { role: findings, type: list, max: 5, optional: true, of: { values: [tests, types, docs] } }
      branch: { type: string, max: 200 }
  brief-shape:
    properties:
      issue: { type: string, min: 3, max: 20 }
receipts:
  reviewer: { shape: reviewer-result }
  publisher: { shape: developer-result, format: header, header: { title: "RECEIPT {agent}", aliases: { status: result }, mode_prefix: true } }
  outsider: { shape: result-base }
`;

const AGENTS = [
  `${api}
kind: Agent
metadata: { name: lead }
spec:
  description: Plans the release and hands work on.
  instructions: ./lead.md
  skills: [../skills/release-notes]
  receipt: reviewer
  brief: brief-shape`,
  `${api}\nkind: Agent\nmetadata: { name: publisher }`,
  `${api}\nkind: Agent\nmetadata: { name: loner }`,
].join("\n---\n");

const GATE = `- gate: Publish after review
  id: reviewed
  agent: publisher
  tool: files
  operation: file.write
  resource: { kind: file, match: any }
  requires:
    - { agent: lead, verdict: [ship, ship-with-debt] }
    - { agent: loner, verdict: pass, since: [lead] }
  otherwise: deny
`;

const FILES = {
  ...RESOURCES,
  "resources/agents.yaml": AGENTS,
  "policies/base.yaml": `${RESOURCES["policies/base.yaml"]}${GATE}`,
  "nodrail.yaml": `${RESOURCES["nodrail.yaml"].replace(
    "runtime: claude-code",
    "runtimes: [claude-code, codex, copilot]",
  )}${SHAPES}`,
};

/** The example a section shows, read back as a receipt reader would. */
function exampleIn(section: string, header?: Record<string, string>) {
  const fenced = /```nodrail-receipt\n([\s\S]*?)\n```/.exec(section);
  if (fenced)
    return parse(fenced[1]!, { schema: "core", uniqueKeys: true }) as Record<
      string,
      unknown
    >;
  const text = /```text\n([\s\S]*?)\n```/.exec(section)![1]!;
  const [, ...lines] = text.split("\n");
  return Object.fromEntries(
    lines.map((line) => {
      const [key, value] = line.split(": ") as [string, string];
      return [header?.[key] ?? key, value];
    }),
  );
}

describe("contracts in a project", () => {
  test("nodrail.yaml shapes and Agent spec.receipt / spec.brief lock, with the engine's digests", async () => {
    const p = await locked(FILES);
    const lock = parse(p.read("nodrail.lock.yaml")) as Record<string, any>;
    expect(lock.contracts.dialect).toBe(1);
    expect(lock.contracts.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(Object.keys(lock.contracts.shapes).sort()).toEqual([
      "brief-shape",
      "developer-result",
      "result-base",
      "reviewer-result",
    ]);
    expect(lock.contractsBaseline.bindings["receipt:reviewer"]).toMatchObject({
      surface: "S01",
      shape: "reviewer-result",
    });
    expect(lock.contractsBaseline.bindings["brief:lead"].shape).toBe(
      "brief-shape",
    );
    expect(lock.contractsBaseline.agents).toEqual({
      lead: { receipt: "reviewer", implicit: false, brief: "brief-shape" },
      loner: { receipt: null, implicit: false, brief: null },
      publisher: { receipt: "publisher", implicit: true, brief: null },
    });
    // The resolved shape carries the parent's properties.
    expect(
      Object.keys(lock.contractsBaseline.shapes["reviewer-result"].properties),
    ).toEqual(
      expect.arrayContaining(["issue", "lesson", "findings", "anchor"]),
    );
    // The lock's contracts section is what the engine checks (C07).
    const sources = {
      manifest: parse(p.read("nodrail.yaml")),
      resources: AGENTS.split("\n---\n").map((text) => parse(text)),
      // The project's rule files, in effect order: the gate reads receipt:reviewer.
      policy: parse(FILES["policies/base.yaml"]),
      lock: lock.contracts,
    };
    expect(compileContracts(sources).issues).toEqual([]);
    // Locked, the project exports and plans as frozen.
    expect((await p.run("policy", "export", "--frozen")).code).toBe(0);
    const plan = planFor(p, "claude-code");
    expect(plan.checks.find((c) => c.name === "policy")?.ok).toBe(true);
    expect(plan.notes.join("\n")).toMatch(
      /Contracts, sha256:[0-9a-f]{12}: each receipt is described in its agent's file, and the hook reads it/,
    );
    expect(plan.notes).toContain("  lead: receipt reviewer, brief brief-shape");
    expect(plan.notes).toContain(
      "  publisher: receipt publisher (by its name)",
    );
  });

  test("each host's agent file gets one marked section; the source file is untouched", async () => {
    const p = await locked(FILES);
    const { claude, copilot } = leadFiles(p);
    const codex = planFor(p, "codex");
    const codexAgent = fileOf(codex, ".codex/agents/publisher.toml");
    const codexEntry = fileOf(codex, ".codex/config.toml");
    for (const text of [claude, copilot]) {
      expect(text.split(SECTION_BEGIN)).toHaveLength(2);
      expect(text.split(SECTION_END)).toHaveLength(2);
      expect(text).toContain(
        "You lead the release.\n\n<!-- nodrail:receipt begin",
      );
      expect(text).toContain(
        "- `verdict` (required; your verdict): one of `ship`, `ship-with-debt`, `fix-first`.",
      );
      expect(text).toContain(
        "- `issue` (required): text, at most 100 characters. Issue id from the brief, or none",
      );
      expect(text).toContain(
        "  - `blocker` (required): a whole number, at least 0.",
      );
      expect(text).toContain(
        '- `due` (optional): a quoted date, "YYYY-MM-DD", at least 2027-01-01.',
      );
    }
    expect(codexEntry).toContain("nodrail:receipt begin: receipt reviewer");
    expect(codexAgent).toContain("RECEIPT publisher");
    // A receipt picked by the agent's name is written too.
    expect(
      fileOf(planFor(p, "claude-code"), ".claude/agents/publisher.md"),
    ).toContain(SECTION_BEGIN);
    expect(p.read("resources/lead.md")).toBe("You lead the release.\n");
  });

  test("the generated examples validate against their contracts, inherited fields included", async () => {
    const p = await locked(FILES);
    const plan = planFor(p, "claude-code");
    const contracts = (await import("../src/commands/project.ts")).frozenPolicy(
      {
        root: p.cwd,
        home: p.home,
      },
    ).contracts!;
    const fenced = exampleIn(fileOf(plan, ".claude/agents/lead.md"));
    expect(fenced.agent).toBe("lead");
    const { agent: _, ...value } = fenced;
    expect(value.due).toBe("2027-01-01");
    expect(value.issue).toBe("example");
    expect(
      validateValue(contracts.shapes["reviewer-result"]!.shape, value),
    ).toEqual([]);
    const header = exampleIn(fileOf(plan, ".claude/agents/publisher.md"), {
      status: "result",
    });
    // The verdict word in capitals, as legacy header receipts write it: the
    // reader takes it in any case, and the section says so.
    expect(header).toEqual({
      result: "DONE",
      categories: "tests",
      branch: "example",
    });
    expect(
      validateValue(contracts.shapes["developer-result"]!.shape, {
        ...header,
        result: (header.result as string).toLowerCase(),
        categories: (header.categories as string).split(", "),
      }),
    ).toEqual([]);
    expect(fileOf(plan, ".claude/agents/publisher.md")).toContain(
      "The verdict word may be in any case (`PASS` or `pass`); every other value is written exactly as listed.",
    );
    expect(fileOf(plan, ".claude/agents/publisher.md")).toContain(
      "You may put your mode before the verdict word",
    );
  });

  test("render prints the same section, also for a receipt no Agent uses", async () => {
    const p = await locked(FILES);
    const plan = planFor(p, "claude-code");
    const rendered = await p.run("contracts", "render", "lead");
    expect(rendered.code).toBe(0);
    expect(fileOf(plan, ".claude/agents/lead.md")).toContain(rendered.out);
    const outsider = await p.run("contracts", "render", "outsider");
    expect(outsider.out).toContain("Start it with `agent: outsider`");
    expect(outsider.out).toContain("What every agent reports");
    const none = await p.run("contracts", "render", "loner");
    expect(none.code).toBe(1);
    expect(none.err).toContain("loner has no declared receipt");
    const json = await p.run("--json", "contracts", "render", "lead");
    expect(JSON.parse(json.out).section).toContain(SECTION_BEGIN);
    expect((await p.run("contracts", "render")).code).toBe(2);
    expect((await p.run("contracts", "nope")).code).toBe(2);
  });

  test("validate checks a sample offline, and never echoes a rejected value", async () => {
    const p = await locked(FILES);
    p.write(
      "samples/good.yaml",
      "verdict: ship\nissue: ENG-1\nfindings: { blocker: 0, major: 1 }\nanchor: fresh\nlesson: keep it\n",
    );
    const good = await p.run(
      "contracts",
      "validate",
      "receipt:reviewer",
      "samples/good.yaml",
    );
    expect(good.code).toBe(0);
    expect(good.out).toContain(
      "valid: samples/good.yaml against receipt:reviewer",
    );
    expect(good.out).toContain(
      'Reported (may leave this machine): {"verdict":"ship","findings":{"blocker":0,"major":1}}',
    );
    expect(good.out).toContain("Withheld: anchor, due, issue, lesson");
    p.write(
      "samples/bad.yaml",
      'verdict: SHIP-IT\nissue: ENG-1\nfindings: { blocker: "0", major: 1 }\nextra: secret-value\n',
    );
    const bad = await p.run(
      "contracts",
      "validate",
      "receipt:reviewer",
      "samples/bad.yaml",
    );
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("verdict: enum");
    expect(bad.out).toContain("findings.blocker: type");
    expect(bad.out).toContain("extra: unknown");
    expect(bad.out).toContain("anchor: required");
    expect(bad.out).not.toContain("SHIP-IT");
    expect(bad.out).not.toContain("secret-value");
    // A message: only its final receipt block counts, with its identity.
    p.write(
      "samples/message.md",
      "Done.\n\n```nodrail-receipt\nagent: lead\nverdict: fix-first\nissue: none\nfindings: { blocker: 1, major: 0 }\nanchor: stale\n```\n",
    );
    expect(
      (
        await p.run(
          "contracts",
          "validate",
          "receipt:reviewer",
          "samples/message.md",
        )
      ).code,
    ).toBe(0);
    p.write(
      "samples/other.md",
      "```nodrail-receipt\nagent: loner\nverdict: ship\nissue: none\nfindings: { blocker: 0, major: 0 }\nanchor: fresh\n```\n",
    );
    const other = await p.run(
      "contracts",
      "validate",
      "receipt:reviewer",
      "samples/other.md",
    );
    expect(other.out).toContain("agent: identity (expected one of lead)");
    p.write(
      "samples/trailing.md",
      "```nodrail-receipt\nverdict: ship\n```\nMore prose after it.\n",
    );
    const trailing = await p.run(
      "contracts",
      "validate",
      "receipt:reviewer",
      "samples/trailing.md",
    );
    expect(trailing.code).toBe(1);
    expect(trailing.out).toContain(
      "missing: samples/trailing.md against receipt:reviewer",
    );
    expect(trailing.out).toContain(
      "no nodrail-receipt block ends the message: it counts as no receipt.",
    );
    // Read as the hook reads it: the verdict and the findings count.
    const read = await p.run(
      "contracts",
      "validate",
      "receipt:reviewer",
      "samples/message.md",
    );
    expect(read.out).toContain(
      "Read as the hook reads it: verdict fix-first, 1 finding",
    );
    p.write(
      "samples/quoted.md",
      "```nodrail-receipt\nagent: lead\nverdict: ship\nissue: none\nfindings: { blocker: 0, major: 0 }\nanchor: fresh\nanchor: stale\n```\n",
    );
    const twice = await p.run(
      "contracts",
      "validate",
      "receipt:reviewer",
      "samples/quoted.md",
    );
    expect(twice.out).toContain("(value): parse");
    expect(twice.out).not.toContain("stale");
    // A shape by name, and a brief.
    p.write("samples/brief.yaml", "issue: ab\n");
    const brief = await p.run(
      "contracts",
      "validate",
      "brief:lead",
      "samples/brief.yaml",
    );
    expect(brief.out).toContain("issue: too-short");
    expect(
      (await p.run("contracts", "validate", "brief-shape", "samples/good.yaml"))
        .code,
    ).toBe(1);
    const json = await p.run(
      "--json",
      "contracts",
      "validate",
      "shape:reviewer-result",
      "samples/good.yaml",
    );
    expect(JSON.parse(json.out)).toMatchObject({ valid: true, issues: [] });
    expect(
      (
        await p.run(
          "contracts",
          "validate",
          "receipt:publisher",
          "samples/message.md",
        )
      ).err,
    ).toContain("No RECEIPT publisher receipt in the file");
    expect(
      (
        await p.run(
          "contracts",
          "validate",
          "receipt:nope",
          "samples/good.yaml",
        )
      ).err,
    ).toContain("No binding or shape receipt:nope");
    expect(
      (
        await p.run(
          "contracts",
          "validate",
          "receipt:reviewer",
          "samples/missing.yaml",
        )
      ).err,
    ).toContain("No file");
    p.write("samples/broken.yaml", "a: [\n");
    expect(
      (
        await p.run(
          "contracts",
          "validate",
          "receipt:reviewer",
          "samples/broken.yaml",
        )
      ).err,
    ).toContain("Not YAML");
  });

  test("validate reads a header receipt with the engine's header reader", async () => {
    const p = await locked(FILES);
    const check = async (text: string) => {
      p.write("samples/header.md", text);
      return p.run(
        "contracts",
        "validate",
        "receipt:publisher",
        "samples/header.md",
      );
    };
    // The agent file's own example, as a final message, reads back valid.
    const file = fileOf(
      planFor(p, "claude-code"),
      ".claude/agents/publisher.md",
    );
    const example = /```text\n[\s\S]*?\n```/.exec(file)![0];
    const own = await check(`Published.\n\n${example}\n`);
    expect(own.code).toBe(0);
    expect(own.out).toContain(
      "Read as the hook reads it: verdict done, 1 finding",
    );
    // Bold header, bullets, a mode prefix, a comma-separated list, a line the
    // contract doesn't map.
    const loose = await check(
      "Shipped.\n\n**RECEIPT publisher**\n- status: release: DONE.\n- categories: tests, docs\n- branch: main\n- notes: dropped by this reader\n",
    );
    expect(loose.code).toBe(0);
    expect(loose.out).toContain("verdict done, 2 findings");
    const json = await p.run(
      "--json",
      "contracts",
      "validate",
      "receipt:publisher",
      "samples/header.md",
    );
    expect(JSON.parse(json.out)).toMatchObject({
      state: "valid",
      verdict: "done",
      findings: 2,
    });
    const other = await check("RECEIPT lead\nstatus: done\nbranch: main\n");
    expect(other.code).toBe(1);
    expect(other.out).toContain("agent: identity (expected one of publisher)");
    const twice = await check(
      "RECEIPT publisher\nstatus: done\nstatus: blocked\nbranch: main\n",
    );
    expect(twice.out).toContain("result: duplicate");
    const word = await check(
      "RECEIPT publisher\nstatus: shipped-it\nbranch: main\n",
    );
    expect(word.out).toContain(
      "invalid: samples/header.md against receipt:publisher",
    );
    expect(word.out).toContain("result: enum");
    expect(word.out).not.toContain("shipped-it");
    const quoted = await check(
      "RECEIPT publisher\nstatus: done\nbranch: main\n\nAnd then more prose.\n",
    );
    expect(quoted.code).toBe(1);
  });

  test("explain shows a binding's conditions and readers, and a gate's requirements", async () => {
    const p = await locked(FILES);
    const binding = await p.run("contracts", "explain", "receipt:reviewer");
    expect(binding.code).toBe(0);
    expect(binding.out).toContain(
      "receipt:reviewer (S01, enforced by the hook)",
    );
    expect(binding.out).toContain("On Codex nothing captures it yet");
    expect(binding.out).toContain("Agents: lead");
    expect(binding.out).toContain(
      "findings.blocker: required, integer, reported",
    );
    expect(binding.out).toContain(
      'gate "Publish after review": verdict ship or ship-with-debt',
    );
    expect(binding.out).toContain("Withheld: anchor, due, issue, lesson");
    const outsider = await p.run("contracts", "explain", "receipt:outsider");
    expect(outsider.out).toContain("`nodrail contracts render outsider`");
    const brief = (await p.run("contracts", "explain", "brief:lead")).out;
    expect(brief).toContain("brief:lead (S02, enforced by the hook)");
    expect(brief).toContain("A prose prompt is not a brief");
    expect(
      (await p.run("contracts", "explain", "shape:result-base")).out,
    ).toContain("not attached here");
    const gate = await p.run("contracts", "explain", "reviewed");
    expect(gate.out).toContain('Gate "Publish after review" (id reviewed)');
    expect(gate.out).toContain("1. lead gives verdict ship or ship-with-debt");
    expect(gate.out).toContain("Read from receipt:reviewer");
    expect(gate.out).toContain(
      "2. loner gives verdict pass, after the last step of lead",
    );
    expect(gate.out).toContain("loner has no declared receipt");
    expect(gate.out).toContain("never allows what no rule allows");
    const missing = await p.run("contracts", "explain", "nothing");
    expect(missing.err).toContain(
      'Known: brief:lead, receipt:outsider, receipt:publisher, receipt:reviewer, "Publish after review"',
    );
  });

  test("a gate waiting for a verdict the receipt can't give, and unknown keys, are refused", async () => {
    const wrong = project({
      ...FILES,
      "policies/base.yaml": FILES["policies/base.yaml"].replace(
        "verdict: [ship, ship-with-debt]",
        "verdict: pass",
      ),
    });
    const lock = await wrong.run("policy", "lock");
    expect(lock.code).toBe(1);
    expect(lock.err).toContain(
      "policies/base.yaml item 2 requires.0.verdict: pass isn't a verdict this receipt can give (verdict-value)",
    );
    const unknown = project({
      ...FILES,
      "nodrail.yaml": `${FILES["nodrail.yaml"]}views: {}\n`,
    });
    const refused = await unknown.run("policy", "lock");
    expect(refused.code).toBe(1);
    expect(refused.err).toContain(
      "The manifest's fields are not valid: views: unknown key",
    );
    const missing = project({
      ...FILES,
      "resources/agents.yaml": AGENTS.replace(
        "receipt: reviewer",
        "receipt: nobody",
      ),
    });
    const err = (await missing.run("policy", "lock")).err;
    expect(err).toContain(
      "Agent lead (resources/agents.yaml) spec.receipt: No receipt named nobody",
    );
    const shape = project({
      ...FILES,
      "nodrail.yaml": FILES["nodrail.yaml"].replace(
        "role: verdict }\n      issue",
        "role: verdict, colour: red }\n      issue",
      ),
    });
    expect((await shape.run("policy", "lock")).err).toContain(
      "nodrail.yaml shapes.result-base",
    );
    const none = await locked();
    expect((await none.run("contracts", "render", "lead")).err).toContain(
      "declares no contracts",
    );
    expect((await none.run("contracts", "explain", "led")).err).toContain(
      "No binding or gate led",
    );
  });

  test("lock and plan tell breaking and disclosure changes apart", async () => {
    const p = await locked(FILES);
    p.write(
      "nodrail.yaml",
      FILES["nodrail.yaml"]
        .replace(
          "anchor: { values: [fresh, stale]",
          "anchor: { values: [fresh]",
        )
        .replace(
          'lesson: { type: string, max: 300, optional: true, for: "A useful lesson" }',
          'lesson: { type: string, max: 300, optional: true, for: "A useful lesson", report: true }\n      owner: { type: string, max: 50 }',
        ),
    );
    const plan = planFor(p, "claude-code");
    expect(plan.checks.find((c) => c.name === "policy")?.ok).toBe(false);
    const notes = plan.notes.join("\n");
    expect(notes).toContain("Contracts, compared with nodrail.lock.yaml:");
    expect(notes).toMatch(
      /breaking\s+receipt:reviewer\s+anchor: no longer accepts stale/,
    );
    expect(notes).toMatch(
      /breaking\s+receipt:reviewer\s+owner: new and required/,
    );
    expect(notes).toMatch(
      /disclosure\s+receipt:reviewer\s+lesson: now reported, so it leaves this machine/,
    );
    expect(notes).toMatch(
      /disclosure\s+receipt:outsider\s+lesson: now reported/,
    );
    const { out } = await p.run("policy", "lock");
    expect(out).toMatch(/Contracts, compared with nodrail\.lock\.yaml on disk/);
    expect(out).toMatch(
      /breaking\s+receipt:reviewer\s+anchor: no longer accepts stale/,
    );
    expect(out).toMatch(/disclosure\s+receipt:reviewer\s+lesson: now reported/);
    expect((await p.run("policy", "lock")).out).toContain("is up to date");
    expect(
      planFor(p, "claude-code").checks.find((c) => c.name === "policy")?.ok,
    ).toBe(true);
  });

  test("the frozen export refuses contracts that differ from the lock", async () => {
    const p = await locked(FILES);
    const lock = p.read("nodrail.lock.yaml");
    p.write(
      "nodrail.lock.yaml",
      lock.replace(/(digest: sha256:)[0-9a-f]{4}/, "$10000"),
    );
    const out = await p.run("policy", "export", "--frozen");
    expect(out.err).toContain("The declared contracts differ from the lock");
  });

  test("the first lock of contracts lists what each binding newly reports", async () => {
    const p = await locked();
    p.write("nodrail.yaml", FILES["nodrail.yaml"]);
    p.write("resources/agents.yaml", AGENTS);
    p.write("policies/base.yaml", FILES["policies/base.yaml"]);
    const { out } = await p.run("policy", "lock");
    expect(out).toMatch(
      /compatible\s+receipt:reviewer\s+new, with shape reviewer-result/,
    );
    expect(out).toMatch(
      /disclosure\s+receipt:reviewer\s+verdict: now reported/,
    );
    expect(out).toMatch(
      /disclosure\s+receipt:reviewer\s+findings\.blocker: now reported/,
    );
  });
});

const prop = (p: Partial<ResolvedProperty> & { type: string }) =>
  ({
    optional: false,
    for: null,
    report: null,
    classification: null,
    role: null,
    ...p,
  }) as ResolvedProperty;

describe("examples", () => {
  test.each([
    prop({ type: "string", min: 12, max: 20 }),
    prop({ type: "string", min: 0, max: 3 }),
    prop({ type: "integer", min: 5.5, max: 9, unit: null }),
    prop({ type: "integer", min: null, max: -3, unit: null }),
    prop({ type: "number", min: 0.5, max: null, unit: "usd" }),
    prop({ type: "boolean" }),
    prop({ type: "date", min: null, max: "2020-02-02" }),
    prop({ type: "date", min: null, max: null }),
    prop({
      type: "list",
      min: 2,
      max: 3,
      role: "findings",
      of: prop({ type: "enum", values: ["a", "b", "c"] }),
    }),
    prop({ type: "list", min: 0, max: 0, of: prop({ type: "boolean" }) }),
    prop({
      type: "list",
      min: 0,
      max: 5,
      of: prop({
        type: "object",
        properties: {
          at: prop({ type: "date", min: "2030-05-05", max: null }),
        },
      }),
    }),
  ])("an example of %o is valid", (property) => {
    const shape: ResolvedShape = { for: null, properties: { x: property } };
    expect(validateValue(shape, exampleValue(shape))).toEqual([]);
    expect(exampleOf(property)).toBeDefined();
  });

  test("dates in a fenced example are quoted, also inside lists", () => {
    const shape: ResolvedShape = {
      for: null,
      properties: {
        verdict: prop({ type: "enum", values: ["ok"], role: "verdict" }),
        due: prop({ type: "date", min: null, max: null }),
        steps: prop({
          type: "list",
          min: 1,
          max: 2,
          of: prop({
            type: "object",
            properties: {
              on: prop({ type: "date", min: null, max: null }),
              days: prop({
                type: "list",
                min: 1,
                max: 1,
                of: prop({ type: "date", min: null, max: null }),
              }),
            },
          }),
        }),
        count: prop({ type: "number", min: null, max: null, unit: "ms" }),
        flag: prop({ type: "boolean", optional: true }),
      },
    };
    const contracts = {
      agents: { a: { receipt: "a", implicit: false, brief: null } },
      bindings: [
        {
          name: "receipt:a",
          surface: "S01",
          shape: "s",
          options: { format: "fenced" },
          digest: "sha256:x",
        },
      ],
      shapes: {
        s: { shape, contract: `sha256:${"0".repeat(64)}`, projection: {} },
      },
    } as unknown as CompiledContracts;
    const section = receiptSection(contracts, "a");
    expect(section).toContain('due: "2026-01-01"');
    expect(section).toContain(
      'steps:\n  - { on: "2026-01-01", days: [ "2026-01-01" ] }',
    );
    expect(section).toContain("`count` (required): a number (ms).");
    expect(section).toContain("`flag` (optional): `true` or `false`.");
    expect(section).toContain("a list of 1 to 2 items, each objects with:");
    expect(receiptSection(null, "a")).toBe("");
    expect(receiptSection(contracts, "b")).toBe("");
  });

  test("an example the bounds make impossible is refused, not shown", () => {
    const shape: ResolvedShape = {
      for: null,
      properties: { n: prop({ type: "integer", min: 5, max: 1, unit: null }) },
    };
    const contracts = {
      agents: {},
      bindings: [
        {
          name: "receipt:a",
          surface: "S01",
          shape: "s",
          options: {},
          digest: "",
        },
      ],
      shapes: { s: { shape, contract: "sha256:0", projection: {} } },
    } as unknown as CompiledContracts;
    expect(() => receiptSection(contracts, "a")).toThrow(
      /Can't make an example of receipt a/,
    );
  });
});

/** Compiled contracts for one receipt with this shape. */
function compiled(properties: string): CompiledContracts {
  const manifest = parse(`shapes:
  s:
    properties:
${properties}
receipts:
  a: { shape: s }
`);
  const result = compileContracts({ manifest });
  expect(result.issues).toEqual([]);
  return result.contracts!;
}

describe("classifying a change", () => {
  const base = `      verdict: { values: [ok, no], role: verdict }
      n: { type: integer, min: 0, max: 10 }
      s: { type: string, max: 50, optional: true }
      tags: { type: list, max: 3, of: { values: [x, y] } }
      when: { type: date, min: "2026-01-01" }
      cost: { type: number, unit: usd }
      deep: { properties: { k: { type: boolean } } }
`;
  const before = lockedContracts(compiled(base)).contractsBaseline;
  const changesTo = (properties: string) =>
    contractChanges(before, compiled(properties)).map(
      (c) => `${c.kind} ${c.subject} ${c.what}`,
    );

  test("nothing changed, nothing to say", () => {
    expect(changesTo(base)).toEqual([]);
  });

  test("narrowing is breaking, widening compatible", () => {
    expect(
      changesTo(
        base
          .replace("max: 10", "max: 5")
          .replace("max: 50, optional: true", "max: 80")
          .replace("of: { values: [x, y] }", "of: { values: [x, y, z] }")
          .replace('min: "2026-01-01"', 'min: "2025-01-01"')
          .replace("unit: usd", "unit: eur")
          .replace("k: { type: boolean }", "k: { type: integer }"),
      ),
    ).toEqual([
      "breaking receipt:a n: bounds narrowed",
      "breaking receipt:a s: now required",
      "breaking receipt:a cost: unit changed from usd to eur",
      "breaking receipt:a deep.k: type changed from boolean to integer",
      "compatible receipt:a s: bounds widened",
      "compatible receipt:a tags[]: also accepts z",
      "compatible receipt:a when: bounds widened",
    ]);
  });

  test("removals, optional additions, roles and instructions", () => {
    expect(
      changesTo(
        `${base.replace("      deep: { properties: { k: { type: boolean } } }\n", "")}      extra: { type: string, optional: true, for: "More" }\n`
          .replace(
            "n: { type: integer, min: 0, max: 10 }",
            'n: { type: integer, min: 0, max: 10, for: "How many" }',
          )
          .replace(
            "tags: { type: list, max: 3,",
            "tags: { role: findings, type: list, max: 2,",
          ),
      ),
    ).toEqual([
      "breaking receipt:a tags: bounds narrowed",
      "breaking receipt:a deep: removed; a value that has it is now refused",
      "unknown receipt:a tags: role changed from none to findings",
      "compatible receipt:a n: its instructions (for) changed",
      "compatible receipt:a extra: new and optional",
    ]);
  });

  test("an agent that ends with another receipt, or loses its brief, is breaking", () => {
    const manifest = parse(`shapes:
  s: { properties: { verdict: { values: [ok], role: verdict } } }
  t: { properties: { verdict: { values: [ok, no], role: verdict } } }
  b: { properties: { issue: { type: string } } }
receipts:
  a: { shape: s }
  c: { shape: t }
`);
    const agent = (spec: object) => ({
      apiVersion: "nodrail.com/v1alpha1",
      kind: "Agent",
      metadata: { name: "x" },
      spec,
    });
    const was = compileContracts({
      manifest,
      resources: [agent({ receipt: "a", brief: "b" })],
    }).contracts!;
    const now = compileContracts({
      manifest,
      resources: [agent({ receipt: "c" })],
    }).contracts!;
    expect(
      contractChanges(lockedContracts(was).contractsBaseline, now)
        .filter((c) => c.subject === "agent x")
        .map((c) => `${c.kind} ${c.what}`),
    ).toEqual([
      "breaking now ends with receipt c (was a)",
      "breaking now takes no declared brief (was b)",
    ]);
  });

  test("reporting less is not a disclosure; a removed receipt is breaking", () => {
    const reported = lockedContracts(
      compiled(
        base.replace(
          "n: { type: integer,",
          "n: { report: true, type: integer,",
        ),
      ),
    ).contractsBaseline;
    expect(
      contractChanges(reported, compiled(base)).map(
        (c) => `${c.kind} ${c.what}`,
      ),
    ).toEqual(["compatible n: no longer reported"]);
    expect(
      contractChanges(before, null).map(
        (c) => `${c.kind} ${c.subject} ${c.what}`,
      ),
    ).toEqual(["breaking receipt:a removed; whatever reads it no longer can"]);
  });
});

test("the package's docs describe the commands", () => {
  const docs = readFileSync(
    join(import.meta.dirname, "../docs/contracts.md"),
    "utf8",
  );
  for (const words of [
    "nodrail contracts render",
    "nodrail contracts validate",
    "nodrail contracts explain",
    "Receipts are enforced",
    "What the hook reads",
  ])
    expect(docs).toContain(words);
});
