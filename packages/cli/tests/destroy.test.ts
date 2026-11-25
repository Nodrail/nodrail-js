// `nodrail destroy` takes out what `nodrail apply` set up, and only that:
// the person's own settings and edits, nodrail.yaml, the lock, the
// resources and connection data stay.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  codexTools,
  filesUnder,
  locked,
  RESOURCES,
  windows,
} from "./support/setup-project.ts";

const both = {
  ...RESOURCES,
  "nodrail.yaml": RESOURCES["nodrail.yaml"].replace(
    "runtime: claude-code",
    "runtimes: [claude-code, codex]",
  ),
};

describe("nodrail destroy", () => {
  test("takes out nodrail's files and entries, keeps the person's and the project's", async () => {
    const p = await locked();
    const before = Object.keys(filesUnder(p.cwd)).sort();
    expect((await p.run("apply", "--yes")).code).toBe(0);
    // The person's own setting, next to nodrail's.
    const settings = JSON.parse(p.read(".claude/settings.json")) as Record<
      string,
      unknown
    >;
    p.write(
      ".claude/settings.json",
      JSON.stringify({ ...settings, theme: "dark" }),
    );
    // And an agent file they changed.
    p.write(
      ".claude/agents/publisher.md",
      `${p.read(".claude/agents/publisher.md")}\nMine.\n`,
    );

    const { code, out } = await p.run("destroy", "--yes");
    expect(code).toBe(0);
    expect(out).toContain("Destroy what nodrail apply set up for Claude Code");
    expect(out).toMatch(/- \.claude\/agents\/lead\.md\s+written by nodrail/);
    expect(out).toMatch(
      /! \.claude\/agents\/publisher\.md\s+edited since nodrail wrote it: kept, yours now/,
    );
    expect(out).toMatch(/~ \.claude\/settings\.json/);
    expect(out).toContain(
      "Kept: nodrail.yaml, nodrail.lock.yaml and the files they name.",
    );

    expect(JSON.parse(p.read(".claude/settings.json"))).toEqual({
      theme: "dark",
    });
    expect(p.read(".claude/agents/publisher.md")).toContain("Mine.");
    const after = Object.keys(filesUnder(p.cwd)).sort();
    expect(after).toEqual(
      [
        ...before,
        ".claude/agents/publisher.md",
        ".claude/settings.json",
      ].sort(),
    );
    // Folders that held only nodrail's files are gone too.
    expect(existsSync(join(p.cwd, ".claude/skills"))).toBe(false);
    expect(existsSync(join(p.cwd, ".nodrail"))).toBe(false);

    // Set up again from scratch, the edited file is the person's.
    const again = await p.run("plan");
    expect(again.out).toMatch(
      /! \.claude\/agents\/publisher\.md\s+.*already there, not written by nodrail/,
    );
  });

  test("a settings file that held only nodrail's entries is removed", async () => {
    const p = await locked();
    await p.run("apply", "--yes");
    expect((await p.run("destroy", "--yes")).code).toBe(0);
    expect(existsSync(join(p.cwd, ".claude"))).toBe(false);
    expect(
      Object.keys(filesUnder(p.cwd)).some((path) =>
        path.startsWith(".nodrail"),
      ),
    ).toBe(false);
  });

  test.skipIf(windows)(
    "one host out, the files the other needs stay; then the other",
    async () => {
      const p = await locked(both, codexTools());
      expect(
        (await p.run("apply", "--runtime", "claude-code", "--yes")).code,
      ).toBe(0);
      await p.run("apply", "--runtime", "codex", "--yes");
      expect(existsSync(join(p.cwd, ".codex/config.toml"))).toBe(true);

      const claude = await p.run(
        "destroy",
        "--runtime",
        "claude-code",
        "--yes",
      );
      expect(claude.code).toBe(0);
      expect(claude.out).toMatch(
        /= \.nodrail\/effective\.yaml\s+kept for Codex/,
      );
      expect(claude.out).toContain("Codex stays set up.");
      expect(existsSync(join(p.cwd, ".claude"))).toBe(false);
      expect(existsSync(join(p.cwd, ".nodrail/effective.yaml"))).toBe(true);
      expect(
        Object.keys(JSON.parse(p.read(".nodrail/setup-state.json")).hosts),
      ).toEqual(["codex"]);

      expect((await p.run("destroy", "--yes")).code).toBe(0);
      expect(existsSync(join(p.cwd, ".codex"))).toBe(false);
      expect(existsSync(join(p.cwd, ".nodrail"))).toBe(false);
      expect(existsSync(join(p.cwd, "nodrail.lock.yaml"))).toBe(true);
    },
  );

  test("names each connection's data, which it keeps", async () => {
    const p = await locked();
    await p.run("apply", "--yes");
    const state = JSON.parse(p.read(".nodrail/setup-state.json")) as {
      hosts: Record<string, Record<string, unknown>>;
    };
    state.hosts["claude-code"]!.data = { "support-memory": ["./memory"] };
    p.write(".nodrail/setup-state.json", JSON.stringify(state));
    p.write("memory/support.jsonl", "{}\n");
    const { out } = await p.run("destroy", "--yes");
    expect(out).toContain(
      "Kept: the data of connection support-memory, at ./memory. Agents can reach it with file tools once the hook is gone.",
    );
    expect(p.read("memory/support.jsonl")).toBe("{}\n");
  });

  test("asks first, and with nothing set up changes nothing", async () => {
    const p = await locked();
    expect((await p.run("destroy")).out).toContain(
      "Nothing here was set up by nodrail apply.",
    );
    await p.run("apply", "--yes");
    const refused = await p.run("destroy");
    expect(refused.code).not.toBe(0);
    expect(refused.err).toContain("asks before removing files");
    expect(existsSync(join(p.cwd, ".claude/settings.json"))).toBe(true);
  });
});
