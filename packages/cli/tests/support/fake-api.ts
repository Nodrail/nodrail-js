import type { Approval, Me, Scope } from "../../src/api.ts";

export const TOKEN = `ndp_0123456789ab_${"A".repeat(43)}`;
export const APPROVAL_ID = "6d1c2f0a-1111-4111-8111-111111111111";
export const RUN_ID = "7e2d3a1b-2222-4222-8222-222222222222";
export const EVENT_ID = "8f3e4b2c-3333-4333-8333-333333333333";

type Options = {
  scopes?: Scope[];
  role?: "viewer" | "approver" | "policy_manager" | "admin";
  /** Answers every call with this error instead. */
  failWith?: { status: number; code: string };
};

type Seen = {
  method: string;
  path: string;
  query: Record<string, string>;
  body: Record<string, unknown> | null;
  authorization: string | null;
};

const roleCan = {
  viewer: { decide: false, rules_write: false },
  approver: { decide: true, rules_write: false },
  policy_manager: { decide: false, rules_write: true },
  admin: { decide: true, rules_write: true },
};

export const pendingApproval = (): Approval => ({
  id: APPROVAL_ID,
  reference: "APR-6D1C2F0A",
  state: "pending",
  reason: "new_permission",
  created_at: "2026-11-12T10:00:00.000Z",
  expires_at: "2026-11-12T11:00:00.000Z",
  agent_key: "support-bot",
  installation_name: "support-bot-prod",
  environment: "Production",
  tool_key: "github",
  operation_key: "issues.delete",
  resource_kind: "issue",
  resource: "acme/support#482",
  parameters: { issue: 482 },
  action_digest: "sha256:abc",
  attempts: 1,
  decided_at: null,
  decided_by: null,
  can_decide: true,
});

export const CURRENT_YAML = "version: 1\nrules:\n  - name: Read issues\n";

/** The personal API's contract in memory, as https://nodrail.com/docs/api says. */
export function fakeApi(options: Options = {}) {
  const scopes = options.scopes ?? ["read"];
  const role = options.role ?? "admin";
  const seen: Seen[] = [];
  const approval = pendingApproval();
  const state = {
    revision: 3,
    yaml: CURRENT_YAML,
    ruleChanged: false,
    /** The live version is level 5: Cloud refuses to show it as a file. */
    notRenderable: false,
  };
  const can = {
    read: true,
    decide: scopes.includes("decide") && roleCan[role].decide,
    rules_write: scopes.includes("rules:write") && roleCan[role].rules_write,
  };
  const me: Me = {
    token: {
      id: "t-1",
      name: "laptop",
      prefix: "ndp_0123456789ab",
      scopes,
      created_at: "2026-11-01T00:00:00.000Z",
      expires_at: "2027-01-30T00:00:00.000Z",
      last_used_at: null,
    },
    person: { name: "Ana Ruiz" },
    workspace: { id: "w-1", name: "Acme", slug: "acme" },
    role,
    can,
    environments: [
      { slug: "development", name: "Development", default: true },
      { slug: "production", name: "Production", default: false },
    ],
  };

  const error = (status: number, code: string) => ({
    status,
    body: { error: { code, request_id: "req-1" } },
  });
  const needs = (scope: Scope, allowed: boolean) =>
    !scopes.includes(scope)
      ? error(403, "INSUFFICIENT_SCOPE")
      : allowed
        ? null
        : error(403, "FORBIDDEN");

  function decide(body: Record<string, unknown>) {
    const refused = needs("decide", can.decide);
    if (refused) return refused;
    if (body.expected_action_digest !== approval.action_digest)
      return error(409, "ACTION_CHANGED");
    approval.state = body.decision === "deny" ? "denied" : "approved_once";
    approval.decided_by = "Ana Ruiz";
    return { status: 200, body: approval };
  }

  function preview(body: Record<string, unknown>) {
    const refused = needs("rules:write", can.rules_write);
    if (refused) return refused;
    const yaml = String(body.yaml);
    const bad = yaml.includes("broken");
    return {
      status: 200,
      body: {
        issues: bad ? [{ line: 2, column: 3, message: "Unknown field" }] : [],
        warnings: [],
        policy_revision: state.revision,
        file_digest: `digest:${yaml.length}`,
        added: yaml === state.yaml ? [] : ["Delete issues"],
        changed: [],
        removed: [],
        unchanged: 1,
      },
    };
  }

  function publish(body: Record<string, unknown>) {
    const refused = needs("rules:write", can.rules_write);
    if (refused) return refused;
    const yaml = String(body.yaml);
    if (
      state.ruleChanged ||
      body.policy_revision !== state.revision ||
      body.file_digest !== `digest:${yaml.length}`
    )
      return error(409, "RULE_CHANGED");
    state.revision += 1;
    state.yaml = yaml;
    return {
      status: 200,
      body: {
        policy_revision: state.revision,
        added: 1,
        changed: 0,
        removed: 0,
        closed_requests: 0,
      },
    };
  }

  const routes: Record<
    string,
    (body: Record<string, unknown>) => { status: number; body: unknown }
  > = {
    "GET /me": () => ({ status: 200, body: me }),
    "GET /approvals": () => ({
      status: 200,
      body: {
        items: approval.state === "pending" ? [approval] : [],
        next_cursor: null,
      },
    }),
    [`GET /approvals/${APPROVAL_ID}`]: () => ({ status: 200, body: approval }),
    [`POST /approvals/${APPROVAL_ID}/decision`]: decide,
    "GET /activity": () => ({
      status: 200,
      body: { items: [activityEvent()], next_cursor: "next-page" },
    }),
    [`GET /activity/${EVENT_ID}`]: () => ({
      status: 200,
      body: { ...activityEvent(), parameters: { issue: 482 }, reports: [] },
    }),
    "GET /runs": () => ({
      status: 200,
      body: { items: [run()], next_cursor: null },
    }),
    [`GET /runs/${RUN_ID}`]: () => ({
      status: 200,
      body: { ...run(), timeline: timeline() },
    }),
    "GET /insights": () => ({ status: 200, body: insights() }),
    "GET /rules": () =>
      state.notRenderable
        ? error(409, "VERSION_NOT_RENDERABLE")
        : {
            status: 200,
            body: { environment: "development", yaml: state.yaml },
          },
    "POST /rules/preview": preview,
    "POST /rules/publish": publish,
  };

  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const method = init?.method ?? "GET";
    const path = url.pathname.replace(/^\/api\/v1/, "");
    const headers = new Headers(init?.headers);
    const body = init?.body ? JSON.parse(init.body as string) : null;
    seen.push({
      method,
      path,
      query: Object.fromEntries(url.searchParams),
      body,
      authorization: headers.get("authorization"),
    });
    const answer =
      headers.get("authorization") !== `Bearer ${TOKEN}`
        ? error(401, "UNAUTHENTICATED")
        : options.failWith
          ? error(options.failWith.status, options.failWith.code)
          : (routes[`${method} ${path}`]?.(body ?? {}) ??
            error(404, "NOT_FOUND"));
    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { "content-type": "application/json" },
    });
  };

  return { fetch: fetch as typeof globalThis.fetch, seen, approval, state, me };
}

function activityEvent() {
  return {
    id: EVENT_ID,
    occurred_at: "2026-11-12T10:05:00.000Z",
    code: "approval_allowed_once",
    group: "decision",
    outcome: "allowed",
    label: "Allowed once",
    actor: { kind: "human", name: "Ana Ruiz", via: "laptop" },
    agent_key: "support-bot",
    action: {
      tool_key: "github",
      operation_key: "issues.delete",
      resource_kind: "issue",
      resource: "acme/support#482",
      installation_name: "support-bot-prod",
      approval_id: APPROVAL_ID,
      run: null,
      reference: "APR-6D1C2F0A",
    },
    environment: "Production",
    rule: null,
    closed_reason: null,
    closed_requests: null,
    subject: null,
    detail: null,
    latest_report: null,
  };
}

function run() {
  return {
    id: RUN_ID,
    key: "ENG-42",
    installation_name: "dev-bot-dev",
    agent_key: "dev-bot",
    created_at: "2026-11-12T09:00:00.000Z",
    last_activity_at: "2026-11-12T10:00:00.000Z",
    steps: 2,
    actions: 1,
    held: 0,
    waiting: 0,
    agents: [],
    holding: null,
    status: "idle",
  };
}

function timeline() {
  const step = {
    step_key: "s-1",
    agent: "qa",
    installation_name: "dev-bot-dev",
    started_at: "2026-11-12T09:00:00.000Z",
    finished_at: "2026-11-12T09:10:00.000Z",
    verdict: "pass",
    findings: [],
  };
  return [
    { kind: "started", at: step.started_at, step },
    { kind: "finished", at: step.finished_at, step },
    {
      kind: "action",
      at: "2026-11-12T09:20:00.000Z",
      action: {
        id: "a-1",
        tool_key: "github",
        operation_key: "pulls.create",
        resource: "acme/app",
        evaluation: "ready",
      },
    },
  ];
}

function insights() {
  return {
    days: 30,
    approvals: {
      requests: 12,
      approved: 9,
      denied: 2,
      expired: 1,
      withdrawn: 0,
      closed: 0,
      waiting: 0,
      median_seconds_to_decide: 42,
      p90_seconds_to_decide: 300,
      decisions: { actions: 40, by_rule: 28, by_person: 12 },
    },
    rules: { top: [], unused: [], newer: 0, active_rules: 4 },
    repeated_approvals: [
      {
        agent_key: "support-bot",
        installation_name: "support-bot-prod",
        tool_key: "github",
        operation_key: "issues.read",
        resource_kind: "issue",
        resource: "acme/support#1",
        approved: 4,
      },
    ],
  };
}
