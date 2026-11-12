import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  agentName,
  MAX_RECEIPT_TEXT,
  receiptBlock,
  runKey,
} from "../src/hook-runs";
import { repositoryName } from "../src/run-key";
import { runKey as ledgerRunKey } from "../src/ledger";
import { parseReceipt } from "../src/receipts";

const fence = (body: string, marks = "```") =>
  `${marks}nodrail-receipt\n${body}\n${marks}`;

describe("receiptBlock", () => {
  test("is the block that ends the message, fences included", () => {
    const block = fence("verdict: pass\nfindings: [a]");
    expect(receiptBlock(`All done.\n\n${block}\n`)).toBe(`${block}\n`);
  });

  test("reads to the same receipt as the whole message", () => {
    const message = `Report.\n${fence("verdict: Ship\nusd: 1.5")}`;
    const block = receiptBlock(message);
    expect(block).not.toBeNull();
    expect(parseReceipt(block ?? "")).toEqual(parseReceipt(message));
  });

  test("ignores a block followed by more text", () => {
    expect(receiptBlock(`${fence("verdict: pass")}\nThen I changed it.`)).toBe(
      null,
    );
  });

  test("takes only the last block, not an earlier quoted one", () => {
    const message = `Example:\n${fence("verdict: pass")}\nMine:\n${fence("verdict: fail")}`;
    expect(receiptBlock(message)).toBe(fence("verdict: fail"));
  });

  test("accepts tilde fences", () => {
    const block = fence("verdict: pass", "~~~");
    expect(receiptBlock(`x\n${block}`)).toBe(block);
  });

  test("is null without a receipt or with one left open", () => {
    expect(receiptBlock("no receipt here")).toBeNull();
    expect(receiptBlock("```nodrail-receipt\nverdict: pass\n")).toBeNull();
  });
});

describe("reading only the end of a message", () => {
  test("200,000 spaces after an opening fence take no time", () => {
    const message = `\`\`\`nodrail-receipt\nverdict: pass\n${" ".repeat(200_000)}x`;
    const started = performance.now();
    expect(receiptBlock(message)).toBeNull();
    expect(parseReceipt(message)).toBeNull();
    expect(performance.now() - started).toBeLessThan(50);
  });

  test("a receipt at the end of a long message is still read", () => {
    const message = `${"x".repeat(500_000)}\n${fence("verdict: pass")}`;
    expect(parseReceipt(message)?.verdict).toBe("pass");
  });

  test("a block longer than the limit is no receipt, here as in Cloud", () => {
    const body = `verdict: pass\nnotes: ${"a".repeat(MAX_RECEIPT_TEXT)}`;
    expect(MAX_RECEIPT_TEXT).toBe(8192);
    expect(receiptBlock(`x\n${fence(body)}`)).toBeNull();
    expect(parseReceipt(`x\n${fence(body)}`)).toBeNull();
  });

  test("a fence cut in the middle of its line is not an opening", () => {
    const message = `${"x".repeat(20_000)}${fence("verdict: pass")}`;
    expect(receiptBlock(message)).toBeNull();
  });
});

describe("repositoryName", () => {
  test.each([
    ["https://user:token@github.com/acme/app.git", "github.com/acme/app"],
    ["https://github.com/acme/app", "github.com/acme/app"],
    ["git@github.com:acme/app.git", "github.com/acme/app"],
    ["ssh://git@GitHub.com:22/acme/app.git/", "github.com/acme/app"],
    [
      "https://x-access-token:ghs_secret@gitlab.example.com/g/sub/app.git",
      "gitlab.example.com/g/sub/app",
    ],
  ])("%s is %s, with no credentials", (remote, name) => {
    expect(repositoryName(remote)).toBe(name);
  });

  test.each([
    "",
    "/srv/git/app.git",
    "file:///srv/git/app.git",
    "C:\\repos\\app",
  ])("a local remote %j has none", (remote) =>
    expect(repositoryName(remote)).toBeNull(),
  );
});

describe("runKey", () => {
  const outsideGit = mkdtempSync(join(tmpdir(), "nodrail-run-key-"));
  // Session pins go in the ledger folder, not the home folder.
  const pins = () => ({
    NODRAIL_LEDGER: mkdtempSync(join(tmpdir(), "nodrail-pins-")),
  });

  function repository(branch: string, remote?: string) {
    const repo = mkdtempSync(join(tmpdir(), "nodrail-key-repo-"));
    const git = (...args: string[]) => spawnSync("git", args, { cwd: repo });
    git("init", "-q", "-b", branch);
    if (remote) git("remote", "add", "origin", remote);
    git(
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "x",
    );
    return { repo, git };
  }

  test("NODRAIL_RUN wins, trimmed and bounded", () => {
    expect(
      runKey(outsideGit, "s", { NODRAIL_RUN: ` ${"x".repeat(250)} ` }),
    ).toBe("x".repeat(200));
  });

  test("outside git it is the session, or nothing", () => {
    expect(runKey(outsideGit, "abc", pins())).toBe("session:abc");
    expect(runKey(outsideGit, null, pins())).toBeNull();
  });

  test("on a branch it is the repository and the branch, with no credentials", () => {
    const { repo } = repository(
      "feature/login",
      "https://user:token@github.com/acme/app.git",
    );
    expect(runKey(repo, "s", pins())).toBe("github.com/acme/app/feature/login");
  });

  test("without a remote the repository is its folder's name", () => {
    const { repo } = repository("feature/login");
    expect(runKey(repo, "s", pins())).toBe(`${basename(repo)}/feature/login`);
  });

  test("on the default branch, or a detached HEAD, it is the session", () => {
    const { repo, git } = repository("main");
    expect(runKey(repo, "s", pins())).toBe("session:s");
    git("switch", "-q", "--detach");
    expect(runKey(repo, "s", pins())).toBe("session:s");
  });

  test("origin's HEAD names the default branch", () => {
    const { repo, git } = repository("trunk", "https://github.com/acme/app");
    git("update-ref", "refs/remotes/origin/trunk", "HEAD");
    git(
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/trunk",
    );
    expect(runKey(repo, "s", pins())).toBe("session:s");
    git("switch", "-q", "-c", "main");
    expect(runKey(repo, "t", pins())).toBe("github.com/acme/app/main");
  });

  test("a session keeps the run it started in after switching branch", () => {
    const { repo, git } = repository("feature/a");
    const env = pins();
    const first = runKey(repo, "s-1", env);
    git("switch", "-q", "-c", "feature/b");
    expect(runKey(repo, "s-1", env)).toBe(first);
    // A new session on the new branch gets its own run.
    expect(runKey(repo, "s-2", env)).toBe(`${basename(repo)}/feature/b`);
  });

  test("a long key is cut to 200 characters", () => {
    const { repo } = repository(`feature/${"b".repeat(250)}`);
    expect(runKey(repo, "s", pins())?.length).toBe(200);
  });

  test("the ledger uses the same rule", () => {
    expect(ledgerRunKey).toBe(runKey);
  });

  test("agent names come with it", () => {
    expect(agentName("Vercel:Deployment Expert")).toBe(
      "vercel-deployment-expert",
    );
  });

  test("the hook entry exports only what hooks need", async () => {
    expect(Object.keys(await import("../src/hook-runs")).sort()).toEqual([
      "MAX_RECEIPT_TEXT",
      "agentName",
      "receiptBlock",
      "runKey",
    ]);
  });
});
