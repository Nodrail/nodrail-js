// A plugin someone else publishes: nodrail.yaml pins it to a git commit, and
// `nodrail plugin fetch` copies exactly that commit's files into the
// project, where the lock covers them. Nothing in the repository runs.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import {
  project as bare,
  RESOURCES,
  windows,
} from "./support/setup-project.ts";

/** A project whose PATH has git too, as the person's would. */
const project = (files: Record<string, string>) => {
  const p = bare(files);
  p.env.PATH += `${delimiter}${process.env.PATH ?? ""}`;
  return p;
};

const PLUGIN = {
  ".claude-plugin/plugin.json": '{"name":"desk-kit","version":"0.2.0"}',
  ".mcp.json":
    '{"mcpServers":{"ledger":{"command":"node","args":["${CLAUDE_PLUGIN_ROOT}/s.cjs"]}}}',
  "s.cjs": "// the ledger server\n",
  "skills/desk-greeting/SKILL.md": "---\nname: desk-greeting\n---\nGreet.\n",
};

/** A git repository with the plugin under plugins/desk-kit; returns commit ids. */
function repository(extra: Record<string, string> = {}) {
  const repo = mkdtempSync(join(tmpdir(), "nodrail-plugin-repo-"));
  const sh = (...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@t", ...args],
      { cwd: repo },
    )
      .toString()
      .trim();
  sh("init", "-q", "-b", "main");
  const commit = (files: Record<string, string>, message: string) => {
    for (const [path, text] of Object.entries(files)) {
      const file = join(repo, "plugins/desk-kit", path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text);
    }
    writeFileSync(join(repo, "README.md"), message);
    sh("add", "-A");
    sh("commit", "-q", "-m", message);
    return sh("rev-parse", "HEAD");
  };
  const first = commit({ ...PLUGIN, ...extra }, "first");
  return { url: pathToFileURL(repo).href, repo, first, commit, sh };
}

const manifest = (
  url: string,
  commit: string,
) => `${RESOURCES["nodrail.yaml"]}plugins:
  desk-kit:
    source: ./vendor/desk-kit
    from: { git: "${url}", commit: "${commit}", path: plugins/desk-kit }
    servers:
      ledger:
        operations:
          record: { resource: { kind: ledger_line, from: line } }
`;

describe("nodrail plugin fetch", () => {
  test("copies the commit's files, which plan and the lock then cover", async () => {
    const { url, first } = repository();
    const p = project({ ...RESOURCES, "nodrail.yaml": manifest(url, first) });
    // Not fetched yet: plan says how to get it.
    const before = await p.run("plan");
    expect(before.out + before.err).toContain(
      `No such folder: run \`nodrail plugin fetch desk-kit\` to copy it from ${url}`,
    );

    const fetched = await p.run("plugin", "fetch", "--yes");
    expect(fetched.code).toBe(0);
    expect(fetched.out).toContain(
      `desk-kit: ${url} at ${first.slice(0, 12)}, plugins/desk-kit → ./vendor/desk-kit`,
    );
    expect(fetched.out).toContain("    + skills/desk-greeting/SKILL.md");
    expect(fetched.out).toContain("Next: `nodrail policy lock`");
    expect(p.read("vendor/desk-kit/s.cjs")).toBe("// the ledger server\n");
    // The repository's own files outside the plugin's folder stay out.
    expect(() => p.read("vendor/desk-kit/README.md")).toThrow();

    expect((await p.run("policy", "lock")).code).toBe(0);
    const planned = await p.run("plan");
    expect(planned.code).toBe(0);
    expect(planned.out).toContain(
      `? plugin desk-kit: copied from ${url} at ${first.slice(0, 12)}; \`nodrail plugin fetch desk-kit --check\` compares it with that commit`,
    );
    expect((await p.run("plugin", "fetch", "--check")).out).toContain(
      "    matches the commit",
    );
  });

  test("--check names a folder that differs, and fetch puts the commit back", async () => {
    const { url, first } = repository();
    const p = project({ ...RESOURCES, "nodrail.yaml": manifest(url, first) });
    await p.run("plugin", "fetch", "--yes");
    p.write("vendor/desk-kit/s.cjs", "// changed here\n");
    p.write("vendor/desk-kit/extra.js", "x");
    const checked = await p.run("plugin", "fetch", "--check");
    expect(checked.code).toBe(1);
    expect(checked.out).toContain("    ~ s.cjs");
    expect(checked.out).toContain("    - extra.js");
    expect(checked.err).toContain("desk-kit differs from the pinned commit.");
    expect((await p.run("plugin", "fetch", "--yes")).code).toBe(0);
    expect(p.read("vendor/desk-kit/s.cjs")).toBe("// the ledger server\n");
    expect(() => p.read("vendor/desk-kit/extra.js")).toThrow();
  });

  test("a new commit is a change the lock shows", async () => {
    const { url, first, commit } = repository();
    const p = project({ ...RESOURCES, "nodrail.yaml": manifest(url, first) });
    await p.run("plugin", "fetch", "--yes");
    await p.run("policy", "lock");
    const second = commit({ "s.cjs": "// the ledger server, v2\n" }, "second");
    p.write("nodrail.yaml", manifest(url, second));
    const fetched = await p.run("plugin", "fetch", "--yes");
    expect(fetched.out).toContain("    ~ s.cjs");
    const plan = await p.run("plan");
    expect(plan.code).toBe(1);
    const lock = await p.run("policy", "lock");
    expect(lock.out).toContain("vendor/desk-kit/s.cjs");
  });

  test("refuses links, missing commits and branches", async () => {
    const withLink = repository();
    writeFileSync(join(withLink.repo, "target.txt"), "../outside.txt");
    const blob = withLink.sh("hash-object", "-w", "target.txt");
    withLink.sh(
      "update-index",
      "--add",
      "--cacheinfo",
      `120000,${blob},plugins/desk-kit/leak`,
    );
    withLink.sh("commit", "-q", "-m", "link");
    const linked = withLink.sh("rev-parse", "HEAD");
    const p = project({
      ...RESOURCES,
      "nodrail.yaml": manifest(withLink.url, linked),
    });
    const refused = await p.run("plugin", "fetch", "--yes");
    expect(refused.code).toBe(1);
    expect(refused.err).toContain(
      "plugins/desk-kit/leak is a link; only plain files are copied.",
    );

    const missing = project({
      ...RESOURCES,
      "nodrail.yaml": manifest(withLink.url, "0".repeat(40)),
    });
    expect((await missing.run("plugin", "fetch", "--yes")).err).toContain(
      `has no commit ${"0".repeat(40)}`,
    );

    const branch = project({
      ...RESOURCES,
      "nodrail.yaml": manifest(withLink.url, "main"),
    });
    const planned = await branch.run("plan");
    expect(planned.out + planned.err).toContain(
      "A full commit id, 40 hex characters: a branch or tag can move",
    );
  });

  test.skipIf(windows)("preserves the POSIX executable bit", async () => {
    const plain = repository();
    plain.sh("update-index", "--chmod=+x", "plugins/desk-kit/s.cjs");
    plain.sh("commit", "-q", "-m", "exec");
    const p = project({
      ...RESOURCES,
      "nodrail.yaml": manifest(plain.url, plain.sh("rev-parse", "HEAD")),
    });
    expect((await p.run("plugin", "fetch", "--yes")).code).toBe(0);
    expect(statSync(join(p.cwd, "vendor/desk-kit/s.cjs")).mode & 0o100).toBe(
      0o100,
    );
  });
});
