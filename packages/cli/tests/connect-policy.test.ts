import { chmodSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  readHostCredential,
  telemetryId,
} from "@nodrail/policy-engine/command-line";
import { z } from "zod";
import { saveToken } from "../src/config.ts";
import { appliedEnrollments } from "../src/setup/applied-enrollment.ts";
import { applySetup } from "../src/setup/apply.ts";
import { planSetup } from "../src/setup/plan.ts";
import { destroySetup, planDestroy } from "../src/setup/destroy.ts";
import type {
  Preview as ProjectApplyPreview,
  ProjectApply,
} from "../src/api.ts";
import { fakeIo } from "./support/fake-io.ts";
import { locked, RESOURCES } from "./support/setup-project.ts";

const ID = "6f1c2a8e-5b7d-4e0f-9a6c-1d2e3f405162";
const ORIGIN = "http://localhost:3100";
const binding = {
  origin: ORIGIN,
  workspace: "acme",
  environment: "development",
  projectId: ID,
};
const installation = "86e4d609-e814-484e-adb5-5e0de4761784";

function machineStatus(
  saved: string | null,
  fresh: boolean,
  machine: ProjectApply["machine"],
) {
  const valid = saved !== null && saved === machine?.credential;
  return Response.json({
    valid,
    fresh: valid && fresh,
    installation_id: valid ? installation : null,
    current_credential: saved?.split("_")[1] ?? null,
  });
}

async function connected() {
  const state = {
    revision: 1,
    additions: ["agent lead", "Never read secrets (.env)", "Project rule"],
    agentChanges: undefined as ProjectApplyPreview["agent_changes"],
    publishes: undefined as boolean | undefined,
    browser: [] as string[],
    writer: true,
    offline: false,
    failApply: false,
    failReconcile: false,
    reconciliations: [] as unknown[],
    removals: [] as string[],
    catalogRemoved: [] as string[],
    takeover: null as {
      project_id: string;
      hosts: { id: string; name: string }[];
    } | null,
    fresh: true,
    issues: [] as { line: number; message: string }[],
    requestPaths: [] as string[],
    observations: [] as unknown[],
    applies: [] as ProjectApply[],
    intended: null as ProjectApply["intended"] | null,
    managed: null as ProjectApply["intended"] | null,
    workspaceLockCurrent: undefined as boolean | undefined,
    credential: null as string | null,
    beforeDisconnect: undefined as (() => Promise<void>) | undefined,
  };
  const publish = (body: ProjectApply) => {
    if (!body.file_digest || state.publishes === false) return null;
    state.managed = body.intended;
    return { policy_revision: ++state.revision };
  };
  const applyProject = (body: ProjectApply) => {
    if (state.failApply)
      return Response.json(
        { error: { message: "Disconnected" } },
        { status: 503 },
      );
    state.applies.push(body);
    state.intended = body.intended;
    const credential = `ndr_00000000000${state.applies.length}_${"X".repeat(43)}`;
    const published = publish(body);
    if (body.machine) state.credential = credential;
    return Response.json({
      published,
      enrollment: body.machine
        ? { credential, installation_id: installation }
        : null,
    });
  };
  const respond = (path: string, body: ProjectApply) => {
    switch (path) {
      case "/api/v1/runtime/disconnect":
        state.credential = null;
        return Response.json({ revoked: true });
      case "/api/v1/runtime/inventory":
        state.observations.push(body);
        return Response.json({ recorded: true });
      case "/api/v1/me":
        return Response.json({
          workspace: { slug: "acme", name: "Acme" },
          person: { name: "Test" },
          token: {
            name: "CLI session",
            prefix: "test",
            scopes: ["read", "rules:write"],
            expires_at: null,
          },
          environments: [{ slug: "development", default: true }],
          can: { rules_write: state.writer },
          effective_scopes: state.writer ? ["read", "rules:write"] : ["read"],
        });
      case "/api/v1/rules/live":
        return Response.json({
          policy_revision: state.revision,
          managed: state.managed,
          source_digest: state.managed?.policy_revision ?? null,
          workspace_lock_current: state.workspaceLockCurrent,
        });
      case "/api/v1/rules/preview":
        return Response.json({
          issues: state.issues,
          added: state.additions,
          agent_changes: state.agentChanges,
          publishes_policy: state.publishes,
          policy_counts: {
            added:
              state.additions.length - (state.agentChanges?.added.length ?? 1),
            changed: 0,
            removed: state.removals.length,
          },
          changed: [],
          removed: state.removals,
          catalog_removed: state.catalogRemoved,
          takeover: state.takeover,
          policy_revision: state.revision,
          file_digest: "preview",
        });
      case "/api/v1/workspace-revisions":
        return Response.json({ revision: state.intended });
      case "/api/v1/projects/enrollment":
        return machineStatus(state.credential, state.fresh, body.machine);
      case "/api/v1/projects/apply":
        return applyProject(body);
      default:
        throw new Error(`Unexpected request ${path}`);
    }
  };
  function checkRequest(url: URL, init?: RequestInit) {
    const authorization = new Headers(init?.headers).get("authorization");
    if (url.pathname.startsWith("/api/v1/runtime/")) {
      expect(authorization).toBe(`Bearer ${state.credential}`);
    } else if (
      !url.pathname.startsWith("/api/v1/cli/") &&
      url.searchParams.get("workspace") !== "misspelled"
    ) {
      expect(url.searchParams.get("workspace")).toBe("acme");
    }
    expect(init?.redirect).toBe("error");
  }

  function connectResponse(url: URL, init?: RequestInit) {
    if (url.pathname === "/api/v1/projects/enrollment/reconcile") {
      expect(new Headers(init?.headers).get("authorization")).toBe(
        `Bearer ndc_${"s".repeat(43)}`,
      );
      if (typeof init?.body !== "string")
        throw new Error("Expected a JSON body");
      state.reconciliations.push(JSON.parse(init.body));
      return state.failReconcile
        ? Response.json({}, { status: 503 })
        : Response.json({ status: "never_activated" });
    }
    if (
      url.pathname === "/api/v1/me" &&
      url.searchParams.get("workspace") === "misspelled"
    )
      return Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 });
    if (url.pathname === "/api/v1/cli/workspaces")
      return Response.json({ items: [{ slug: "acme" }, { slug: "other" }] });
  }

  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    expect(url.origin).toBe(ORIGIN);
    checkRequest(url, init);
    state.requestPaths.push(url.pathname);
    if (state.offline) throw new Error("fetch failed");
    const special = connectResponse(url, init);
    if (special) return special;
    if (url.pathname === "/api/v1/cli/login/start") return Response.json({});
    if (url.pathname === "/api/v1/cli/login/exchange")
      return Response.json({ token: `ndc_${"a".repeat(43)}` });
    if (
      url.pathname === "/api/v1/runtime/disconnect" &&
      state.beforeDisconnect
    ) {
      state.credential = null;
      await state.beforeDisconnect();
      return Response.json({ revoked: true });
    }
    return respond(
      url.pathname,
      typeof init?.body === "string" ? JSON.parse(init.body) : {},
    );
  };
  const p = await locked(
    {
      ...RESOURCES,
      "nodrail.yaml": `${RESOURCES["nodrail.yaml"].replace("imports:\n", 'imports:\n  - "@nodrail/read-only"\n')}id: ${ID}
connect:
  url: ${ORIGIN}
  workspace: acme
  environment: development
  decide: cloud
`,
    },
    undefined,
    fetcher,
  );
  Object.assign(p.env, { NODRAIL_URL: ORIGIN, NODRAIL_TOKEN: "ndp_person" });
  return { p, state, fetcher };
}

describe("connected project setup", () => {
  const savedAfterCleanup = (p: Awaited<ReturnType<typeof connected>>["p"]) =>
    readHostCredential(p.home, binding);

  async function finishDestroy(p: Awaited<ReturnType<typeof connected>>["p"]) {
    const retry = await p.run("destroy", "--yes", "--json");
    expect(retry.code, retry.err).toBe(0);
    expect(JSON.parse(retry.out)).toMatchObject({
      destroyed: [],
      credential_revoked: true,
    });
    expect(await savedAfterCleanup(p)).toBeNull();
  }

  test.each(["missing", "edited"])(
    "destroy revokes when connect.json is %s",
    async (state) => {
      const { p } = await connected();
      expect((await p.run("apply", "--yes")).code).toBe(0);
      if (state === "missing") unlinkSync(join(p.cwd, ".nodrail/connect.json"));
      else p.write(".nodrail/connect.json", "user edit");
      const result = await p.run("destroy", "--yes");
      expect(result.code, result.err).toBe(0);
      expect(result.out).toContain(
        `Disconnected this machine from acme/development at ${ORIGIN}`,
      );
      expect(await savedAfterCleanup(p)).toBeNull();
      if (state === "edited")
        expect(p.read(".nodrail/connect.json")).toBe("user edit");
    },
  );

  test("destroy can resume after an interruption between local cleanup and disconnect", async () => {
    const { p, state } = await connected();
    expect((await p.run("apply", "--yes")).code).toBe(0);
    const place = { root: p.cwd, home: p.home, env: p.env };
    destroySetup(place, planDestroy(place), "`nodrail destroy`");
    expect(() => p.read(".nodrail/setup-state.json")).toThrow();
    expect(await savedAfterCleanup(p)).toMatchObject({
      credential: state.credential,
    });
    await finishDestroy(p);
  });

  test("an offline destroy retains the credential, fails, and revokes on retry", async () => {
    const { p, state } = await connected();
    expect((await p.run("apply", "--yes")).code).toBe(0);
    state.offline = true;
    const destroyed = await p.run(
      "destroy",
      "--runtime",
      "claude-code",
      "--yes",
      "--json",
    );
    expect(destroyed.code).toBe(1);
    expect(destroyed.err).toContain(
      `disconnect incomplete: run \`nodrail destroy\` again or revoke at ${ORIGIN}/app/acme/development/agents`,
    );
    expect(JSON.parse(destroyed.out)).toMatchObject({
      destroyed: ["claude-code"],
      credential_revoked: false,
    });
    expect(() => p.read(".nodrail/connect.json")).toThrow();
    expect(await savedAfterCleanup(p)).toMatchObject({
      credential: state.credential,
    });
    state.offline = false;
    await finishDestroy(p);
  });

  test("destroy preserves an uncertain intent then clears a never-activated generation with the personal session", async () => {
    const { p, state } = await connected();
    await saveToken(p.home, ORIGIN, `ndc_${"s".repeat(43)}`);
    state.failApply = true;
    expect((await p.run("apply", "--yes")).code).toBe(1);
    delete p.env.NODRAIL_TOKEN;
    const place = { root: p.cwd, home: p.home };
    const [intent] = appliedEnrollments(place);
    expect(intent).toHaveProperty("credential");
    state.failReconcile = true;
    expect((await p.run("destroy", "--yes")).code).toBe(1);
    expect(appliedEnrollments(place)).toEqual([intent]);
    state.failReconcile = false;
    const done = await p.run("destroy", "--yes");
    expect(done.code, done.err).toBe(0);
    expect(done.out).toContain("never activated");
    expect(appliedEnrollments(place)).toEqual([]);
    expect(state.reconciliations).toEqual(
      Array.from({ length: 2 }, () => ({
        project_id: ID,
        machine_id: expect.any(String),
        generation: expect.stringMatching(/^[a-f0-9]{12}$/),
      })),
    );
    expect(state.requestPaths).not.toContain("/api/v1/runtime/disconnect");
  });

  test("first connected apply gives a teammate the whole sign-in, plan and apply sequence", async () => {
    const { p } = await connected();
    const result = await p.run("apply", "--yes");
    expect(result.code, result.err).toBe(0);
    expect(result.out).toContain(
      `nodrail login --url ${ORIGIN}\n  nodrail plan\n  nodrail apply`,
    );
    expect(result.out).toContain("Hook configured:");
    expect(result.out).toContain("first-check decision");
    expect(result.out).not.toContain("Hook active");
  });

  test("destroy help describes cleanup and what remains", async () => {
    const { p } = await connected();
    const help = await p.run("destroy", "--help");
    expect(help.out).toContain(
      "Remove generated setup and disconnect this machine",
    );
    expect(help.out).toContain(
      "Published policy, history, connect: in nodrail.yaml",
    );
    expect(help.out).toContain("nodrail logout");
  });

  test.each([
    [
      "misspelled",
      "development",
      ORIGIN,
      "Workspaces this login can see: acme, other.",
    ],
    ["acme", "bogus", ORIGIN, "Choose an environment in acme: development."],
    ["acme", "development", "http://other.example.test", "https"],
  ])(
    "connect validates %s/%s at %s before writing either project file",
    async (workspace, environment, origin, hint) => {
      const { p } = await connected();
      delete p.env.NODRAIL_TOKEN;
      await saveToken(p.home, ORIGIN, `ndc_${"s".repeat(43)}`);
      const manifest = p.read("nodrail.yaml");
      const lock = p.read("nodrail.lock.yaml");
      const failure = await p.run(
        "connect",
        origin,
        "--workspace",
        workspace,
        "--environment",
        environment,
      );
      expect(failure.code).toBe(1);
      expect(failure.err).toContain(`${workspace}/${environment} at ${origin}`);
      expect(failure.err).toContain(
        "copy the command from Agents → Connect a project",
      );
      expect(failure.err.toLowerCase()).toContain(hint.toLowerCase());
      expect(p.read("nodrail.yaml")).toBe(manifest);
      expect(p.read("nodrail.lock.yaml")).toBe(lock);
    },
  );

  test("support-desk's first and later plans fit on one screen; details expand the diff", async () => {
    const { p, state } = await connected();
    const root = join(p.cwd, "desk");
    expect((await p.run("example", "support-desk", "./desk")).code).toBe(0);
    const place = { root, home: p.home, env: p.env, runtime: "claude-code" };
    applySetup(place, planSetup(place));
    const manifest = p.read("desk/nodrail.yaml");
    p.write(
      "desk/nodrail.yaml",
      `${manifest}
connect: { url: ${ORIGIN}, workspace: acme, environment: development, decide: cloud }
`,
    );
    expect((await p.runFrom(root, "policy", "lock")).code).toBe(0);
    const ownRules = Array.from({ length: 56 }, (_, i) => `Desk rule ${i + 1}`);
    const catalog = [
      ...planSetup({
        root,
        home: p.home,
        env: p.env,
        runtime: "claude-code",
      }).catalogRules,
    ];
    expect(catalog).toHaveLength(85);
    state.additions = [
      "agent marketing",
      "agent support",
      ...catalog,
      ...ownRules,
    ];
    state.agentChanges = {
      added: ["marketing", "support"],
      changed: [],
      removed: [],
    };
    const first = await p.runFrom(root, "plan", "--runtime", "claude-code");
    expect(first.code, first.err).toBe(0);
    expect(first.out.split("\n").length).toBeLessThanOrEqual(25);
    expect(first.out).toContain(
      `project desk (claude-code) · acme/development at ${ORIGIN}`,
    );
    expect(first.out).toContain(
      "publishes policy v2: 141 added, 0 changed, 0 removed",
    );
    expect(first.out).toContain("+ agent marketing");
    expect(first.out).toContain("+ agent support");
    expect(first.out).toContain("56 project rule changes");
    expect(first.out).toContain("85 catalog rule changes");
    expect(first.out).toContain("Setup: 2 setup changes on this machine.");
    expect(first.out).toContain("Hook configured:");
    expect(first.out).toContain("Policy revision pending: yes.");
    expect(first.out).not.toContain("Desk rule 56");

    const details = await p.runFrom(
      root,
      "plan",
      "--runtime",
      "claude-code",
      "--details",
    );
    expect(details.out).toContain("+ Desk rule 56");
    expect(details.out).toContain("+ Never read secrets (.env)");
    expect(details.out).toContain(".nodrail/connect.json");

    state.revision = 2;
    state.additions = ["One new rule"];
    state.removals = ["Old project rule"];
    state.agentChanges = {
      added: [],
      changed: ["support"],
      removed: ["old-agent"],
    };
    const later = await p.runFrom(
      root,
      "plan",
      "--runtime",
      "claude-code",
      "--replace-live",
    );
    expect(later.code, later.err).toBe(0);
    expect(later.out.split("\n").length).toBeLessThanOrEqual(25);
    expect(later.out).toContain(
      "publishes policy v3: 1 added, 0 changed, 1 removed",
    );
    expect(later.out).toContain("+ One new rule");
    expect(later.out).toContain("- Old project rule");
    expect(later.out).toContain("~ agent support");
    expect(later.out).toContain("- agent old-agent");
  });

  test("connected plan and apply use the same setup units while the installed hook stays active", async () => {
    const { p } = await connected();
    expect((await p.run("apply", "--yes")).code).toBe(0);
    p.write("nodrail.yaml", p.read("nodrail.yaml") + "  enforce: watch\n");
    expect((await p.run("policy", "lock")).code).toBe(0);
    const planned = await p.run("plan");
    expect(planned.out).toContain("Setup: 1 setup change on this machine");
    expect(planned.out).toContain("Hook configured:");
    expect(planned.out).toContain("Policy revision pending: yes.");
    const applied = await p.run("apply", "--yes");
    expect(applied.code, applied.err).toBe(0);
    expect(applied.out).toContain("Applied 1 setup change on this machine.");
    const current = await p.run("plan");
    expect(current.out).toContain("Hook configured:");
    expect(current.out).toContain("Policy revision pending: no.");
  });

  test("apply changes only the host mode while retaining the live policy version", async () => {
    const { p, state } = await connected();
    expect((await p.run("apply", "--yes")).code).toBe(0);
    p.write("nodrail.yaml", p.read("nodrail.yaml") + "  enforce: watch\n");
    expect((await p.run("policy", "lock")).code).toBe(0);
    state.additions = [];
    state.agentChanges = { added: [], changed: [], removed: [] };
    state.publishes = false;
    const later = await p.run("plan");
    expect(later.code, later.err).toBe(0);
    expect(later.out).toContain("keeps policy v2");
    expect(later.out).toContain("1 setup change on this machine (watch mode)");
    const applied = await p.run("apply", "--yes");
    expect(applied.code, applied.err).toBe(0);
    expect(applied.out).toContain("Policy mode: watch mode");
    expect(applied.out).not.toContain("Published policy");
    expect(JSON.parse(p.read(".nodrail/connect.json")).enforce).toBe("watch");
    expect(state.revision).toBe(2);
    state.writer = false;
    state.workspaceLockCurrent = true;
    const readerPlan = await p.run("plan");
    expect(readerPlan.code, readerPlan.err || readerPlan.out).toBe(0);
    expect(readerPlan.out).toContain("Nothing to change.");
  });

  test("connect edits a local project, signs in once, and plans without applying", async () => {
    const { p, state, fetcher } = await connected();
    const manifest = `# Keep this comment\n${RESOURCES["nodrail.yaml"]}connect: { decide: local, enforce: watch }\n`;
    p.write("nodrail.yaml", manifest);
    expect((await p.run("policy", "lock")).code).toBe(0);
    chmodSync(join(p.cwd, "nodrail.yaml"), 0o600);
    chmodSync(join(p.cwd, "nodrail.lock.yaml"), 0o640);
    delete p.env.NODRAIL_TOKEN;
    const runConnect = async () => {
      const io = fakeIo({
        cwd: p.cwd,
        home: p.home,
        env: p.env,
        fetch: fetcher,
      });
      io.io.openBrowser = (url) => state.browser.push(url);
      const code = await io.run(
        "connect",
        ORIGIN,
        "--workspace",
        "acme",
        "--environment",
        "development",
        "--runtime",
        "claude-code",
        "--json",
      );
      expect(code, io.stderr()).toBe(0);
      return JSON.parse(io.stdout());
    };
    expect(await runConnect()).toMatchObject({ ready: true, mode: "watch" });
    expect(state.browser).toEqual([
      expect.stringMatching(/\/api\/v1\/cli\/login\/approve\//),
    ]);
    expect(p.read("nodrail.yaml")).toMatch(/^# Keep this comment/);
    expect(p.read("nodrail.yaml")).toMatch(/^id: [0-9a-f-]{36}$/m);
    if (process.platform !== "win32") {
      expect(statSync(join(p.cwd, "nodrail.yaml")).mode & 0o777).toBe(0o600);
      expect(statSync(join(p.cwd, "nodrail.lock.yaml")).mode & 0o777).toBe(
        0o640,
      );
    }
    const connectedManifest = p.read("nodrail.yaml");
    expect(connectedManifest).toContain("environment: development");
    expect(connectedManifest).toContain("decide: cloud");
    expect(await runConnect()).toMatchObject({ ready: true });
    expect(state.browser).toHaveLength(1);
    expect(p.read("nodrail.yaml")).toBe(connectedManifest);
    expect(state.applies).toEqual([]);
    expect(() => p.read(".nodrail/connect.json")).toThrow();
  });

  test("connect checks publish permission on the proposed manifest before writing", async () => {
    const { p, state } = await connected();
    p.write("nodrail.yaml", RESOURCES["nodrail.yaml"]);
    expect((await p.run("policy", "lock")).code).toBe(0);
    const manifest = p.read("nodrail.yaml");
    const lock = p.read("nodrail.lock.yaml");
    state.writer = false;
    const result = await p.run(
      "connect",
      ORIGIN,
      "--workspace",
      "acme",
      "--environment",
      "development",
    );
    expect(result.code).toBe(1);
    expect(result.out).toContain("requires rules:write");
    expect(p.read("nodrail.yaml")).toBe(manifest);
    expect(p.read("nodrail.lock.yaml")).toBe(lock);
    expect(state.applies).toEqual([]);
  });

  test("connect displays the permission diff and leaves unlocked edits for explicit review", async () => {
    const { p, state } = await connected();
    const manifest = p.read("nodrail.yaml");
    const lock = p.read("nodrail.lock.yaml");
    p.write(
      "policies/base.yaml",
      p.read("policies/base.yaml").replace("effect: allow", "effect: deny"),
    );
    const args = [
      "connect",
      ORIGIN,
      "--workspace",
      "acme",
      "--environment",
      "development",
    ];
    const result = await p.run(...args);
    expect(result.code).toBe(1);
    expect(result.err).toContain(
      "Permissions, compared with nodrail.lock.yaml",
    );
    expect(result.err).toContain("file.read");
    expect(result.err).toContain("`nodrail policy lock`");
    expect(p.read("nodrail.yaml")).toBe(manifest);
    expect(p.read("nodrail.lock.yaml")).toBe(lock);
    expect(state.requestPaths).toEqual([]);
    expect((await p.run("policy", "lock")).code).toBe(0);
    expect((await p.run(...args)).code).toBe(0);
  });

  test("destroy preserves the legacy recovery state when connect.json cannot be trusted", async () => {
    const { p } = await connected();
    expect((await p.run("apply", "--yes")).code).toBe(0);
    rmSync(join(p.home, ".nodrail", "applied"), { recursive: true });
    p.write(".nodrail/connect.json", "edited");
    const result = await p.run("destroy", "--yes");
    expect(result.code).toBe(1);
    expect(result.err).toContain("Legacy machine revocation is unresolved");
    expect(result.err).toContain("`nodrail destroy --yes`");
    expect(p.read(".nodrail/setup-state.json")).toContain("claude-code");
    expect(await savedAfterCleanup(p)).not.toBeNull();
  });

  test("destroy settling an old revoke keeps the rotated credential and recovery record", async () => {
    const { p, state } = await connected();
    expect((await p.run("apply", "--yes")).code).toBe(0);
    const old = state.credential;
    state.beforeDisconnect = async () => {
      const rotated = await p.run("apply", "--yes");
      expect(rotated.code, rotated.err).toBe(0);
    };
    expect((await p.run("destroy", "--yes")).code).toBe(0);
    expect(state.credential).toBeTruthy();
    expect(state.credential).not.toBe(old);
    expect(await savedAfterCleanup(p)).toMatchObject({
      credential: state.credential,
    });
    expect(appliedEnrollments({ root: p.cwd, home: p.home })).toMatchObject([
      {
        installationId: installation,
        generation: state.credential?.split("_")[1],
      },
    ]);
    state.beforeDisconnect = undefined;
    expect((await p.run("destroy", "--yes")).code).toBe(0);
    expect(await savedAfterCleanup(p)).toBeNull();
  });

  test("the concise preview groups removals from a catalog no longer imported", async () => {
    const { p, state } = await connected();
    state.removals = ["Removed catalog rule", "Removed project rule"];
    state.catalogRemoved = ["Removed catalog rule"];
    const plan = await p.run("plan", "--replace-live");
    expect(plan.code, plan.err).toBe(0);
    expect(plan.out).toContain("- Removed project rule");
    expect(plan.out).not.toContain("- Removed catalog rule");
    expect(plan.out).toContain("2 catalog rule changes");
    expect((await p.run("plan", "--replace-live", "--details")).out).toContain(
      "- Removed catalog rule",
    );
  });

  test("connect, plan and apply reuse a legacy machine ID", async () => {
    const { p, state } = await connected();
    const file = join(p.home, ".nodrail", "machine-id");
    const legacy = "1234567890ab0def0fedcba987654321\n";
    const expected = "12345678-90ab-4def-8fed-cba987654321";
    mkdirSync(join(p.home, ".nodrail"), { recursive: true });
    writeFileSync(file, legacy);

    const results = [
      await p.run(
        "connect",
        ORIGIN,
        "--workspace",
        "acme",
        "--environment",
        "development",
      ),
      await p.run("plan"),
      await p.run("apply", "--yes"),
    ];
    for (const result of results) expect(result.code, result.err).toBe(0);
    expect(z.uuid().parse(state.applies[0]?.machine?.id)).toBe(expected);
    expect(telemetryId(p.home)).toBe(expected.replaceAll("-", ""));
    expect(readFileSync(file, "utf8")).toBe(legacy);
  });

  test("apply reports how to repair a malformed machine ID", async () => {
    const { p, state } = await connected();
    const file = join(p.home, ".nodrail", "machine-id");
    mkdirSync(join(p.home, ".nodrail"), { recursive: true });
    writeFileSync(file, "damaged");

    const result = await p.run("apply", "--yes");
    expect(result.code).toBe(1);
    expect(result.out).toContain("rm ~/.nodrail/machine-id");
    expect(result.out).toContain("then run `nodrail apply` again");
    expect(state.applies).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe("damaged");
  });

  test("previews and adopts bootstrap, publishes intentions, then reuses or rotates the machine key", async () => {
    const { p, state } = await connected();
    const plan = await p.run("plan");
    expect(plan.code).toBe(0);
    expect(plan.out).toContain(
      "Apply publishes policy v2: 2 added, 0 changed, 0 removed",
    );
    expect(plan.out).toContain("+ agent lead");
    expect(plan.out).toContain("+ Project rule");
    expect(plan.out).toContain("1 catalog rule change");
    expect(plan.out).not.toContain("+ Never read secrets (.env)");
    expect((await p.run("plan", "--details")).out).toContain(
      "+ Never read secrets (.env)",
    );
    expect(() => readdirSync(join(p.home, ".nodrail", "hosts"))).toThrow();
    expect(state.applies).toEqual([]);

    const apply = await p.run("apply", "--yes");
    expect(apply.code).toBe(0);
    expect(apply.out).toContain("Activity → Runs");
    expect(state.observations).toMatchObject([
      { host: "claude-code", agent: "lead", drift: 0 },
    ]);
    const [sent] = state.applies;
    expect(sent?.declarations).toMatchObject({
      project_id: ID,
      agents: expect.arrayContaining([{ key: "publisher", description: null }]),
    });
    expect(sent?.intended).toMatchObject({
      project_id: ID,
      files: expect.arrayContaining([
        expect.objectContaining({ path: "nodrail.yaml" }),
      ]),
    });
    expect(sent?.file_digest).toBe("preview");
    const credential = await readHostCredential(p.home, binding);
    expect(credential).toMatchObject({
      credential: state.credential,
      origin: ORIGIN,
      installationId: installation,
    });
    expect(p.read(".nodrail/connect.json")).not.toContain("ndr_");
    expect(apply.out).not.toContain(state.credential!);
    const hosts = join(p.home, ".nodrail", "hosts");
    const file = join(hosts, readdirSync(hosts)[0]!);
    if (process.platform !== "win32")
      expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(
      await readHostCredential(p.home, {
        ...binding,
        origin: "https://another.example",
      }),
    ).toBeNull();

    state.writer = false;
    state.requestPaths.length = 0;
    expect((await p.run("apply", "--yes")).code).toBe(0);
    expect(state.requestPaths).not.toContain("/api/v1/rules/preview");
    expect(state.applies).toHaveLength(1);
    writeFileSync(
      file,
      JSON.stringify({ ...credential, origin: "https://another.example" }),
    );
    expect(await readHostCredential(p.home, binding)).toBeNull();
    writeFileSync(file, "null");
    expect(await readHostCredential(p.home, binding)).toBeNull();
    unlinkSync(file);
    const blocked = await p.run("plan");
    expect(blocked.code).toBe(1);
    expect(blocked.out).toContain(
      "Enrolling this machine requires rules:write",
    );
    state.writer = true;
    expect((await p.run("apply", "--yes")).code).toBe(0);
    expect(state.applies).toHaveLength(2);
    expect(state.applies[1]?.machine?.id).toBe(sent?.machine?.id);
    expect(await readHostCredential(p.home, binding)).toMatchObject({
      credential: state.credential,
      installationId: installation,
    });
    expect(state.credential).not.toBe(credential?.credential);
  });

  test("shows all preview issues and real takeover removals", async () => {
    const { p, state } = await connected();
    state.issues = [
      { line: 7, message: "No agent called ghost" },
      { line: 14, message: "No installation called missing" },
    ];
    const failed = await p.run("plan");
    expect(failed.code).toBe(1);
    expect(failed.out).toContain("No agent called ghost (line 7)");
    expect(failed.out).toContain("No installation called missing (line 14)");
    state.issues = [];
    state.removals = ["Existing project rule"];
    state.takeover = {
      project_id: ID,
      hosts: [{ id: installation, name: "existing host" }],
    };
    const plan = await p.run("plan", "--replace-live");
    expect(plan.code).toBe(0);
    expect(plan.out).toContain("- Existing project rule");
    expect(plan.out).toContain("`nodrail apply --replace-live`");
    const apply = await p.run("apply");
    expect(apply.code).toBe(1);
    expect(apply.out).toContain("- Existing project rule");
    expect(state.applies).toHaveLength(0);
  });

  test("a takeover with an empty diff still lists hosts and requires --replace-live", async () => {
    const { p, state } = await connected();
    state.takeover = {
      project_id: ID,
      hosts: [{ id: installation, name: "previous host" }],
    };
    const refused = await p.run("apply", "--yes");
    expect(refused.code).toBe(1);
    expect(refused.out).toContain("previous host");
    expect(refused.out).toContain("Takes over");
    expect(state.applies).toHaveLength(0);
    const accepted = await p.run("apply", "--yes", "--replace-live");
    expect(accepted.code).toBe(0);
    expect(accepted.out).toContain("previous host");
    expect(state.applies[0]?.replace_live).toBe(true);
  });

  test("a valid stale machine credential is sent back for reconciliation", async () => {
    const { p, state } = await connected();
    expect((await p.run("apply", "--yes")).code).toBe(0);
    const credential = state.credential;
    state.fresh = false;
    const refresh = await p.run("apply", "--yes");
    expect(refresh.code).toBe(0);
    expect(refresh.out).toContain(
      "refreshes this machine's agent keys and credential scopes",
    );
    expect(state.applies[1]?.machine?.credential).toBe(credential);
  });

  test("offline and missing publish scope block both commands", async () => {
    const { p, state } = await connected();
    state.writer = false;
    for (const args of [["plan"], ["apply", "--yes"]]) {
      const run = await p.run(...args);
      expect(run.code).toBe(1);
      expect(run.out).toContain("requires rules:write");
    }
    expect(state.requestPaths).not.toContain("/api/v1/rules/preview");
    state.offline = true;
    for (const args of [["plan"], ["apply", "--yes"]]) {
      const run = await p.run(...args);
      expect(run.code).toBe(1);
      expect(run.out).toContain("fetch failed");
    }
    expect(state.applies).toHaveLength(0);
  });
});

test("the linked playbook defaults to browser login and automatic enrollment", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  expect(readme).toContain("docs/playbooks.md#connect-to-nodrail");
  const playbook = readFileSync(
    new URL("../docs/playbooks.md", import.meta.url),
    "utf8",
  );
  const [onboarding, ci] = playbook
    .split("### Connect to Nodrail")[1]!
    .split("#### CI and unattended hosts");
  expect(onboarding).toMatch(/nodrail connect[\s\S]*nodrail apply/);
  expect(onboarding).toContain("enrolls");
  expect(onboarding).toContain("Activity → Runs");
  expect(onboarding).not.toContain("fromEnv");
  expect(ci).toContain("credential: { fromEnv: NODRAIL_CREDENTIAL }");
});
