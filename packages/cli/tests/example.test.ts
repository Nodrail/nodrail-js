// The support-desk example as a person gets it: copied out of the package,
// planned for either host from its shipped lock, and deciding each call as
// its README says.
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { examplesFolder } from "../src/commands/example.ts";
import { fakeIo } from "./support/fake-io.ts";
import { codexTools, windows } from "./support/setup-project.ts";

const SOURCE = join(examplesFolder(), "support-desk");

async function run(
  cwd: string,
  argv: string[],
  extra: { stdin?: string; env?: Record<string, string> } = {},
) {
  const terminal = fakeIo({
    cwd,
    home: mkdtempSync(join(tmpdir(), "nodrail-home-")),
    fetch: (() => {
      throw new Error("network used");
    }) as unknown as typeof fetch,
    ...extra,
  });
  const code = await terminal.run(...argv);
  return { code, out: terminal.stdout(), err: terminal.stderr() };
}

describe("nodrail example", () => {
  test("lists the examples and copies one into a new folder", async () => {
    const parent = mkdtempSync(join(tmpdir(), "nodrail-example-"));
    expect((await run(parent, ["example"])).out).toContain("support-desk");
    const copied = await run(parent, ["example", "support-desk", "desk"]);
    expect(copied.code).toBe(0);
    expect(copied.out).toContain("nodrail plan ./desk --runtime claude-code");
    expect(readFileSync(join(parent, "desk/nodrail.yaml"), "utf8")).toBe(
      readFileSync(join(SOURCE, "nodrail.yaml"), "utf8"),
    );
    const again = await run(parent, ["example", "support-desk", "desk"]);
    expect(again.code).toBe(1);
    expect(again.err).toContain("isn't empty");
    expect((await run(parent, ["example", "nope"])).err).toContain(
      "There is no example nope. There are: support-desk.",
    );
  });

  test("its lock is the one locking it gives today", async () => {
    const desk = mkdtempSync(join(tmpdir(), "nodrail-desk-"));
    cpSync(SOURCE, desk, { recursive: true });
    const shipped = readFileSync(join(desk, "nodrail.lock.yaml"), "utf8");
    expect((await run(desk, ["policy", "lock"])).code).toBe(0);
    // If this fails, run `nodrail policy lock` in examples/support-desk.
    expect(readFileSync(join(desk, "nodrail.lock.yaml"), "utf8")).toBe(shipped);
  });
});

describe.skipIf(windows)("the example, planned and deciding", () => {
  const desk = mkdtempSync(join(tmpdir(), "nodrail-desk-"));
  cpSync(SOURCE, desk, { recursive: true });
  const bin = codexTools();
  const env = { PATH: bin };

  test("plans on either host from its lock, starting nothing", async () => {
    for (const runtime of ["claude-code", "codex"]) {
      const { code, out } = await run(desk, ["plan", "--runtime", runtime], {
        env,
      });
      expect(out).toContain("✓ policy: matches nodrail.lock.yaml");
      expect(out).toContain(
        "handbook: runs nodrail connector files-search --folder ./handbook --receipts ./activity",
      );
      expect(code).toBe(0);
    }
    expect(existsSync(join(desk, "activity/reads.jsonl"))).toBe(false);
    // Each plan starts the fake hosts' programs; the first is slow when cold.
  }, 30_000);

  test("decides each call as the README's table says", async () => {
    const policy = await run(desk, ["policy", "export", "--frozen"]);
    expect(policy.code).toBe(0);
    const file = join(desk, "effective.yaml");
    writeFileSync(file, policy.out);
    const connections = join(desk, "connections.json");
    const yaml = readFileSync(join(desk, "nodrail.yaml"), "utf8");
    expect(yaml).toContain("handbook:");
    writeFileSync(
      connections,
      JSON.stringify({
        connections: {
          handbook: {
            operations: {
              search: { resource: { kind: "collection", from: "collection" } },
            },
          },
          outbox: {
            operations: {
              publish: { resource: { kind: "channel", from: "channel" } },
            },
          },
        },
      }),
    );
    const decide = async (
      agent: string | null,
      tool: string,
      input: object,
      host?: string,
    ) => {
      const { out } = await run(
        desk,
        [
          "policy",
          "hook",
          file,
          "--connections",
          connections,
          "--agent",
          "marketing",
          ...(host ? ["--host", host] : []),
        ],
        {
          stdin: JSON.stringify({
            hook_event_name: "PreToolUse",
            tool_name: tool,
            tool_input: input,
            ...(agent ? { agent_type: agent } : {}),
          }),
        },
      );
      return out === ""
        ? "allow"
        : (
            JSON.parse(out) as {
              hookSpecificOutput: { permissionDecision: string };
            }
          ).hookSpecificOutput.permissionDecision;
    };
    const search = (collection: string) => ({
      collection,
      query: "escalation",
    });
    const publish = { channel: "blog", text: "Returns go to LANTERN." };
    expect(await decide(null, "mcp__handbook__search", search("public"))).toBe(
      "allow",
    );
    expect(
      await decide("support", "mcp__handbook__search", search("public")),
    ).toBe("allow");
    expect(
      await decide(null, "mcp__handbook__search", search("internal")),
    ).toBe("deny");
    expect(
      await decide("support", "mcp__handbook__search", search("internal")),
    ).toBe("allow");
    expect(await decide(null, "mcp__outbox__publish", publish)).toBe("deny");
    // Support publishes to the help center only: the blog is denied, on
    // either host, and nothing waits for a person.
    expect(await decide("support", "mcp__outbox__publish", publish)).toBe(
      "deny",
    );
    expect(
      await decide("support", "mcp__outbox__publish", publish, "codex"),
    ).toBe("deny");
    expect(
      await decide("support", "mcp__outbox__publish", {
        ...publish,
        channel: "help-center",
      }),
    ).toBe("allow");
    expect(
      await decide(null, "Agent", { subagent_type: "support", prompt: "go" }),
    ).toBe("allow");
    expect(
      await decide("support", "Agent", {
        subagent_type: "marketing",
        prompt: "go",
      }),
    ).toBe("deny");
    // Each agent may load the skill set up for it, and no other.
    expect(await decide(null, "Skill", { skill: "cite-sources" })).toBe(
      "allow",
    );
    expect(await decide("support", "Skill", { skill: "cite-sources" })).toBe(
      "allow",
    );
    expect(await decide(null, "Skill", { skill: "vercel:deploy" })).toBe(
      "deny",
    );
  });
});
