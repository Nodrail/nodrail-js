// A project that declares no contracts is locked and set up byte for byte
// as before contracts existed. The files under fixtures/unchanged/ were
// written by nodrail 0.3.2 (before declared contracts) from this project;
// the lock's engine line was regenerated when the engine moved to level 4,
// the only line that changed.
import { describe, expect, test } from "vitest";
import { planSetup } from "../src/setup/plan.ts";
import { locked, RESOURCES } from "./support/setup-project.ts";

const files = {
  ...RESOURCES,
  "nodrail.yaml": RESOURCES["nodrail.yaml"].replace(
    "runtime: claude-code",
    "runtimes: [claude-code, codex, copilot]",
  ),
};

const golden = (name: string) =>
  `./fixtures/unchanged/${name.replace(/^\./, "").replaceAll("/", "__")}`;

describe("a project without contracts", () => {
  test("its lock and agent files are what nodrail wrote before contracts", async () => {
    const p = await locked(files);
    await expect(p.read("nodrail.lock.yaml")).toMatchFileSnapshot(
      golden("nodrail.lock.yaml"),
    );
    for (const runtime of ["claude-code", "codex", "copilot"]) {
      const plan = planSetup({
        root: p.cwd,
        home: p.home,
        env: p.env,
        runtime,
      });
      const agents = plan.files.filter((file) =>
        /^\.(claude|codex|github)\/agents\//.test(file.path),
      );
      expect(agents.length).toBeGreaterThan(0);
      for (const file of agents)
        await expect(file.content.toString()).toMatchFileSnapshot(
          golden(file.path),
        );
    }
  });
});
