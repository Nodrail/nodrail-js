// The tested profile: the exact versions a workspace was tested with. `plan`
// compares them with what runs here; another version is unverified, said
// plainly, and doesn't block.
import { describe, expect, test } from "vitest";
import { testedCheck } from "../src/setup/tested.ts";
import { VERSION } from "../src/version.ts";
import { locked, RESOURCES } from "./support/setup-project.ts";

const running = { nodrail: "0.5.0", node: "22.22.3", "claude-code": "2.1.328" };

describe("comparing with the tested profile", () => {
  test("the same versions run as tested", () => {
    expect(
      testedCheck(
        {
          nodrail: "0.5.0",
          node: "22.22.3",
          "claude-code": "2.1.328",
          codex: "0.170.0",
        },
        "claude-code",
        running,
      ),
    ).toEqual({
      name: "tested",
      ok: true,
      detail:
        "runs as tested: nodrail 0.5.0, node 22.22.3, claude-code 2.1.328",
    });
  });

  test("another version, or none tested, is unverified and doesn't block", () => {
    expect(
      testedCheck({ nodrail: "0.5.0", node: "24.1.0" }, "claude-code", running),
    ).toEqual({
      name: "tested",
      ok: true,
      unverified: true,
      detail:
        "unverified here: node 22.22.3 (tested 24.1.0); no tested version for claude-code",
    });
    expect(
      testedCheck({ codex: "0.170.0" }, "codex", {
        nodrail: "0.5.0",
        node: "22.22.3",
      })?.detail,
    ).toBe(
      "unverified here: codex not found (tested 0.170.0); no tested version for nodrail, node",
    );
  });

  test("no profile, no check", () => {
    expect(testedCheck(null, "codex", running)).toBeNull();
  });
});

const withTested = (tested: string) => ({
  ...RESOURCES,
  "nodrail.yaml": `${RESOURCES["nodrail.yaml"]}tested:\n${tested}`,
});

describe("plan with a tested profile", () => {
  test("shows what runs as tested", async () => {
    const p = await locked(
      withTested(
        `  nodrail: ${VERSION}\n  node: ${process.versions.node}\n  claude-code: 2.1.327\n`,
      ),
    );
    const { code, out } = await p.run("plan");
    expect(out).toContain(
      `✓ tested: runs as tested: nodrail ${VERSION}, node ${process.versions.node}, claude-code 2.1.327`,
    );
    expect(code).toBe(0);
  });

  test("marks a newer host unverified, and still plans", async () => {
    const p = await locked(
      withTested(
        `  nodrail: ${VERSION}\n  node: ${process.versions.node}\n  claude-code: 2.1.328\n`,
      ),
    );
    const { code, out } = await p.run("plan");
    expect(out).toContain(
      "? tested: unverified here: claude-code 2.1.327 (tested 2.1.328)",
    );
    expect(code).toBe(0);
    const json = JSON.parse((await p.run("plan", "--json")).out) as {
      checks: { name: string; unverified?: boolean }[];
    };
    expect(json.checks.find((check) => check.name === "tested")).toMatchObject({
      ok: true,
      unverified: true,
    });
  });

  test("refuses a version that isn't exact", async () => {
    const p = await locked(RESOURCES);
    p.write(
      "nodrail.yaml",
      `${RESOURCES["nodrail.yaml"]}tested:\n  claude-code: "2.1"\n`,
    );
    const { code, err, out } = await p.run("plan");
    expect(code).not.toBe(0);
    expect(`${err}${out}`).toContain(
      "nodrail.yaml: The manifest's fields are not valid",
    );
  });
});
