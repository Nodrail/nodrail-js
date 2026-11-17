import { describe, expect, test } from "vitest";
import { lineDiff } from "../src/diff.ts";
import { CURRENT_YAML, TOKEN, fakeApi } from "./support/fake-api.ts";
import { fakeIo } from "./support/fake-io.ts";

const NEW_YAML = `${CURRENT_YAML}  - name: Delete issues\n`;
const writer = () => fakeApi({ scopes: ["read", "rules:write"] });
const at = (
  api: ReturnType<typeof fakeApi>,
  extra: Parameters<typeof fakeIo>[0] = {},
) =>
  fakeIo({
    fetch: api.fetch,
    env: { NODRAIL_TOKEN: TOKEN },
    files: { "rules.yaml": NEW_YAML },
    ...extra,
  });

describe("rules pull", () => {
  test("to stdout, to a file and as json", async () => {
    const t = at(fakeApi());
    expect(await t.run("rules", "pull")).toBe(0);
    expect(t.stdout()).toBe(CURRENT_YAML.trimEnd());
    expect(await t.run("rules", "pull", "out.yaml")).toBe(0);
    expect(t.files.get("out.yaml")).toBe(CURRENT_YAML);
    const json = at(fakeApi());
    await json.run("rules", "pull", "--json");
    expect(JSON.parse(json.stdout()).yaml).toBe(CURRENT_YAML);
  });
});

describe("rules push", () => {
  test("previews, shows the diff, asks and publishes what it previewed", async () => {
    const api = writer();
    const t = at(api, { interactive: true, answers: ["yes"] });
    expect(await t.run("rules", "push", "rules.yaml")).toBe(0);
    expect(t.stdout()).toContain("+   - name: Delete issues");
    expect(t.stdout()).toContain("Added:\n  Delete issues");
    expect(t.asked[0]?.question).toContain("Publish to development?");
    expect(api.seen.at(-1)).toMatchObject({
      path: "/rules/publish",
      body: {
        yaml: NEW_YAML,
        policy_revision: 3,
        file_digest: `digest:${NEW_YAML.length}`,
      },
    });
    expect(t.stdout()).toContain("Published revision 4.");
    expect(api.state.yaml).toBe(NEW_YAML);
  });

  test("declining publishes nothing", async () => {
    const api = writer();
    const t = at(api, { interactive: true, answers: ["n"] });
    expect(await t.run("rules", "push", "rules.yaml")).toBe(1);
    expect(api.seen.some((call) => call.path === "/rules/publish")).toBe(false);
  });

  test("a file with problems is never published", async () => {
    const api = writer();
    const t = at(api, { files: { "rules.yaml": "broken: [" } });
    expect(await t.run("rules", "push", "rules.yaml", "--yes")).toBe(1);
    expect(t.stdout()).toContain("line 2:3 Unknown field");
    expect(api.seen.some((call) => call.path === "/rules/publish")).toBe(false);
  });

  test("the same file has nothing to publish", async () => {
    const t = at(writer(), { files: { "rules.yaml": CURRENT_YAML } });
    expect(await t.run("rules", "push", "rules.yaml", "--yes")).toBe(0);
    expect(t.stdout()).toContain("Nothing to publish.");
  });

  test("rules that changed since the preview are explained", async () => {
    const api = writer();
    api.state.ruleChanged = true;
    const t = at(api);
    expect(await t.run("rules", "push", "rules.yaml", "--yes", "--json")).toBe(
      1,
    );
    expect(t.stderr()).toContain("The rules changed since the preview");
    expect(t.stderr()).toContain("RULE_CHANGED");
  });

  test("needs rules:write, a file and a person", async () => {
    const t = at(fakeApi());
    expect(await t.run("rules", "push", "rules.yaml", "--yes")).toBe(1);
    expect(t.stderr()).toContain("INSUFFICIENT_SCOPE");
    expect(await at(writer()).run("rules", "push", "rules.yaml")).toBe(2);
    expect(await at(writer()).run("rules", "push")).toBe(2);
    expect(await at(writer()).run("rules")).toBe(2);
    expect(await at(writer()).run("rules", "pull", "a", "b")).toBe(2);
  });

  test("json output of a publish", async () => {
    const t = at(writer());
    expect(await t.run("rules", "push", "rules.yaml", "-y", "--json")).toBe(0);
    expect(JSON.parse(t.stdout()).published.policy_revision).toBe(4);
  });
});

describe("lineDiff", () => {
  test("marks changes with context and separates distant hunks", () => {
    const before = "a\nb\nc\nd\ne\nf\ng\nh\ni\n";
    const after = "a\nB\nc\nd\ne\nf\ng\nh\nI\n";
    expect(lineDiff(before, after)).toEqual([
      "@@",
      "  a",
      "- b",
      "+ B",
      "  c",
      "  d",
      "@@",
      "  g",
      "  h",
      "- i",
      "+ I",
    ]);
    expect(lineDiff("x", "x")).toEqual([]);
  });

  test("summarises files too large to compare", () => {
    const big = Array.from({ length: 2100 }, (_, i) => `l${i}`).join("\n");
    expect(lineDiff(big, `${big}\nmore`)[0]).toContain("too large");
  });
});
