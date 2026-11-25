import { expect, test } from "vitest";
import {
  catalogRuleIds,
  catalogRuleMarker,
} from "../src/catalog-provenance.ts";
import type { CompiledRule } from "../src/rules-file.ts";

const ids = ["catalog-rule", "local-rule"];
const rules: CompiledRule[] = ids.map((id, index) => ({
  id,
  name: id,
  description: null,
  tags: [],
  source: { file: "effective.yaml", line: 2 + index * 2 },
}));
const sections =
  "# ── @nodrail/base\n- rule: Catalog\n# ── local\n- rule: Local\n";

test("older rendered policies attribute rules by their source section", () => {
  expect(catalogRuleMarker([])).toBe("");
  expect([...catalogRuleIds(sections.replaceAll("\n", "\r\n"), rules)]).toEqual(
    ["catalog-rule"],
  );
});

test("an explicit catalog marker overrides the source-section fallback", () => {
  const marker = catalogRuleMarker(["local-rule", "local-rule"]);
  const shifted = rules.map((rule) => ({
    ...rule,
    source: { ...rule.source, line: rule.source.line + 1 },
  }));
  expect([...catalogRuleIds(marker + sections, shifted)]).toEqual([
    "local-rule",
  ]);
  expect([
    ...catalogRuleIds("# Nodrail catalog rule IDs: [1]\n" + sections, shifted),
  ]).toEqual([]);
});
