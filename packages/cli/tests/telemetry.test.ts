// `telemetry` in nodrail.yaml: apply writes where the hook sends each
// decision, both hosts' hooks pass it, and plan says how sending went.
import { describe, expect, test } from "vitest";
import { TELEMETRY_FILE } from "../src/setup/connections.ts";
import {
  codexTools,
  locked,
  recordSenderStatus,
  RESOURCES,
  windows,
} from "./support/setup-project.ts";

const TELEMETRY = `telemetry:
  traces:
    endpoint: http://127.0.0.1:4318/v1/traces
    headers:
      authorization: { fromEnv: OTLP_TOKEN }
`;

async function project(runtime = "claude-code") {
  const files = {
    ...RESOURCES,
    "nodrail.yaml": `${RESOURCES["nodrail.yaml"].replace("claude-code", runtime)}${TELEMETRY}`,
  };
  const p = await locked(files, runtime === "codex" ? codexTools() : undefined);
  p.env.OTLP_TOKEN = "Bearer not-in-files";
  return p;
}

const recorded = recordSenderStatus;

describe.skipIf(windows)("telemetry", () => {
  test("apply writes where to send, and the hook is told", async () => {
    const p = await project();
    const plan = await p.run("plan");
    expect(plan.code).toBe(0);
    expect(plan.out).toContain(
      "✓ secret OTLP_TOKEN: set; given only to the telemetry sender",
    );
    expect(plan.out).toContain(`+ ${TELEMETRY_FILE}`);
    expect(plan.out).toContain(
      "Telemetry: each decision goes to http://127.0.0.1:4318/v1/traces; none sent yet.",
    );
    expect((await p.run("apply", "--yes")).code).toBe(0);
    expect(JSON.parse(p.read(TELEMETRY_FILE))).toEqual({
      project: p.cwd.split("/").pop(),
      traces: {
        endpoint: "http://127.0.0.1:4318/v1/traces",
        protocol: "otlp-http/protobuf",
        headers: { authorization: { fromEnv: "OTLP_TOKEN" } },
      },
    });
    expect(p.read(".claude/settings.json")).toContain(
      `--telemetry \\"$CLAUDE_PROJECT_DIR/${TELEMETRY_FILE}\\"`,
    );
  });

  test("a missing header secret blocks the plan, naming it", async () => {
    const p = await project();
    delete p.env.OTLP_TOKEN;
    const { code, out } = await p.run("plan");
    expect(code).toBe(1);
    expect(out).toContain(
      "! secret OTLP_TOKEN: missing; the telemetry sender needs it",
    );
  });

  test("plan says how sending went, and a receiver that is down blocks nothing", async () => {
    const p = await project();
    recorded(p, {
      state: "ok",
      at: "2026-11-18T10:00:00Z",
      sent: 12,
      dropped: 0,
    });
    expect((await p.run("plan")).out).toContain(
      "Telemetry: 12 kept by http://127.0.0.1:4318/v1/traces; last at 2026-11-18T10:00:00Z.",
    );
    // Without an id in nodrail.yaml, reports can't tell a clone from another project.
    expect((await p.run("plan")).out).toMatch(
      /add `id: [0-9a-f-]{36}` to nodrail.yaml/,
    );
    recorded(p, {
      state: "degraded",
      at: "2026-11-18T10:02:00Z",
      sent: 12,
      rejected: 2,
      unknown: 1,
      lastRejection: "only nodrail.observation spans are kept",
      dropped: 0,
    });
    expect((await p.run("plan")).out).toContain(
      "Telemetry: 12 kept by http://127.0.0.1:4318/v1/traces; 2 refused by the receiver, 1 with no readable answer (only nodrail.observation spans are kept); last at 2026-11-18T10:02:00Z.",
    );
    recorded(p, {
      state: "degraded",
      at: "2026-11-18T10:05:00Z",
      sent: 12,
      dropped: 3,
      error: "fetch failed",
    });
    const { code, out } = await p.run("plan");
    expect(code).toBe(0);
    expect(out).toContain(
      "Telemetry is degraded: fetch failed at 2026-11-18T10:05:00Z; 3 dropped.",
    );
  });

  test("a raw token as bearer, and the project's id, reach the sender's settings", async () => {
    const id = "0d7c1b2a-3e4f-4a5b-8c6d-7e8f9a0b1c2d";
    const p = await locked({
      ...RESOURCES,
      "nodrail.yaml": `id: ${id}\n${RESOURCES["nodrail.yaml"]}telemetry:\n  traces:\n    endpoint: https://app.nodrail.com/api/v1/otlp/v1/traces\n    bearer: { fromEnv: NODRAIL_TOKEN }\n`,
    });
    p.env.NODRAIL_TOKEN = "ndp_0123456789ab_raw";
    const plan = await p.run("plan");
    expect(plan.out).toContain(
      "secret NODRAIL_TOKEN: set; given only to the telemetry sender",
    );
    expect(plan.out).not.toContain("add `id:");
    await p.run("apply", "--yes");
    expect(JSON.parse(p.read(TELEMETRY_FILE))).toMatchObject({
      projectId: id,
      traces: { bearer: { fromEnv: "NODRAIL_TOKEN" }, headers: {} },
    });
    expect(p.read(TELEMETRY_FILE)).not.toContain("ndp_");
  });

  test("Codex's hook sends too", async () => {
    const p = await project("codex");
    await p.run("apply", "--yes");
    expect(p.read(".codex/hooks.json")).toContain("--telemetry '");
  });
});
