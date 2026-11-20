/**
 * A small client for Nodrail's personal API (`/api/v1`, `ndp_` tokens). The
 * command line and the MCP server both use it, so each call is written once.
 */

export const DEFAULT_URL = "https://app.nodrail.com";

/** C0 and C1 control characters, and DEL: what a terminal acts on. */
const isControl = (code: number) =>
  code < 0x20 || (code >= 0x7f && code <= 0x9f);

const escapeControls = (text: string, keep: ReadonlySet<string>) =>
  Array.from(text, (character) =>
    isControl(character.charCodeAt(0)) && !keep.has(character)
      ? `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`
      : character,
  ).join("");

/**
 * Text from the server as plain characters. Agents choose resource ids and
 * members choose names, so a control character in them could move the cursor
 * or rewrite what a terminal or a prompt shows before someone decides.
 */
export const visible = (text: string) => escapeControls(text, new Set());

/** As `visible`, keeping line breaks and tabs, for text laid out in lines. */
export const visibleLines = (text: string) =>
  escapeControls(text, new Set(["\n", "\t"]));

export type Scope = "read" | "decide" | "rules:write" | "inventory:write";

export type Me = {
  token: {
    id: string;
    name: string;
    prefix: string;
    scopes: Scope[];
    created_at: string;
    expires_at: string | null;
    last_used_at: string | null;
  };
  person: { name: string };
  workspace: { id: string; name: string; slug: string };
  role: string;
  can: { read: boolean; decide: boolean; rules_write: boolean };
  environments: { slug: string; name: string; default: boolean }[];
};

export type Approval = {
  id: string;
  reference: string;
  state: string;
  reason: string;
  created_at: string;
  expires_at: string;
  agent_key: string;
  installation_name: string;
  environment: string;
  tool_key: string;
  operation_key: string;
  resource_kind: string;
  resource: string;
  /** As the agent sent it. Untrusted. */
  parameters: Record<string, unknown>;
  action_digest: string;
  attempts: number;
  decided_at: string | null;
  decided_by: string | null;
  can_decide: boolean;
  [field: string]: unknown;
};

export type Page<T> = { items: T[]; next_cursor: string | null };

export type ActivityEvent = {
  id: string;
  occurred_at: string;
  code: string;
  outcome: string;
  label: string;
  actor: { kind: string; name: string | null; via?: string | null };
  agent_key: string | null;
  action: {
    tool_key: string;
    operation_key: string;
    resource: string;
    reference: string;
  } | null;
  subject: string | null;
  detail: string | null;
  [field: string]: unknown;
};

export type Run = {
  id: string;
  key: string;
  agent_key: string | null;
  status: string;
  steps: number;
  actions: number;
  waiting: number;
  held: number;
  last_activity_at: string;
  [field: string]: unknown;
};

export type Preview = {
  issues: { line: number; column: number; message: string }[];
  warnings: { line: number; column: number; message: string }[];
  policy_revision: number;
  file_digest: string;
  added: string[];
  changed: string[];
  removed: string[];
  unchanged: number;
};

export type Published = {
  policy_revision: number;
  added: number;
  changed: number;
  removed: number;
  closed_requests: number;
};

export type Decision = "allow_once" | "deny";

/** The workspace revision a team intends for a project, in an environment. */
export type IntendedRevision = {
  project: string;
  project_id: string;
  revision: string;
  policy_revision: string | null;
  files: { path: string; sha256: string }[];
  published_by: string;
  published_at: string;
};

export type Query = Record<string, string | number | undefined>;

/** An answer from the API that isn't a success, with its code and request id. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly requestId: string | null,
  ) {
    super(`${code}${requestId ? ` (request ${requestId})` : ""}`);
    this.name = "ApiError";
  }
}

export type ApiOptions = {
  token: string;
  url?: string;
  /** An environment's slug; the workspace's default when left out. */
  environment?: string;
  fetch?: typeof fetch;
};

const enc = encodeURIComponent;

function parseJson(text: string): unknown {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function failure(status: number, body: unknown) {
  const error = (body as { error?: { code?: string; request_id?: string } })
    ?.error;
  return new ApiError(
    status,
    error?.code ?? `HTTP_${status}`,
    error?.request_id ?? null,
  );
}

/**
 * The URL with any slashes at its end removed. A loop, not a regular
 * expression, so a URL of many slashes takes no longer than its length.
 */
export function withoutTrailingSlashes(url: string) {
  let end = url.length;
  while (end > 0 && url[end - 1] === "/") end -= 1;
  return url.slice(0, end);
}

export class NodrailApi {
  readonly url: string;
  private readonly token: string;
  private readonly environment: string | undefined;
  private readonly fetcher: typeof fetch;

  constructor(options: ApiOptions) {
    this.url = withoutTrailingSlashes(options.url ?? DEFAULT_URL);
    this.token = options.token;
    this.environment = options.environment;
    this.fetcher = options.fetch ?? fetch;
  }

  private async call<T>(
    method: "GET" | "POST",
    path: string,
    options: { query?: Query; body?: object; scoped?: boolean } = {},
  ): Promise<T> {
    const query = { ...options.query };
    if (options.scoped !== false && this.environment)
      query.environment = this.environment;
    const response = await this.fetcher(this.target(path, query), {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: "application/json",
        ...(options.body ? { "content-type": "application/json" } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const parsed = parseJson(await response.text());
    if (!response.ok) throw failure(response.status, parsed);
    return parsed as T;
  }

  private target(path: string, query: Query) {
    const target = new URL(`${this.url}/api/v1${path}`);
    for (const [name, value] of Object.entries(query))
      if (value !== undefined && value !== "")
        target.searchParams.set(name, String(value));
    return target;
  }

  me() {
    return this.call<Me>("GET", "/me", { scoped: false });
  }

  approvals(query: { agent?: string } = {}) {
    return this.call<Page<Approval>>("GET", "/approvals", { query });
  }

  approval(id: string) {
    return this.call<Approval>("GET", `/approvals/${enc(id)}`);
  }

  decide(id: string, decision: Decision, expectedActionDigest: string) {
    return this.call<Approval>("POST", `/approvals/${enc(id)}/decision`, {
      body: { decision, expected_action_digest: expectedActionDigest },
    });
  }

  activity(query: Query = {}) {
    return this.call<Page<ActivityEvent>>("GET", "/activity", { query });
  }

  event(id: string) {
    return this.call<ActivityEvent>("GET", `/activity/${enc(id)}`);
  }

  runs(query: Query = {}) {
    return this.call<Page<Run>>("GET", "/runs", { query });
  }

  run(id: string) {
    return this.call<Run & { timeline: unknown[] }>("GET", `/runs/${enc(id)}`);
  }

  insights(days?: number) {
    return this.call<Record<string, unknown>>("GET", "/insights", {
      query: { days },
    });
  }

  rules() {
    return this.call<{ environment: string; yaml: string }>("GET", "/rules");
  }

  previewRules(yaml: string) {
    return this.call<Preview>("POST", "/rules/preview", { body: { yaml } });
  }

  intendedRevision(projectId: string) {
    return this.call<{ revision: IntendedRevision | null }>(
      "GET",
      "/workspace-revisions",
      { query: { project_id: projectId } },
    );
  }

  publishRevision(body: {
    project: string;
    project_id: string;
    revision: string;
    policy_revision: string | null;
    files: { path: string; sha256: string }[];
  }) {
    return this.call<{ revision: IntendedRevision; previous: string | null }>(
      "POST",
      "/workspace-revisions",
      { body },
    );
  }

  publishRules(
    yaml: string,
    preview: Pick<Preview, "policy_revision" | "file_digest">,
  ) {
    return this.call<Published>("POST", "/rules/publish", {
      body: {
        yaml,
        policy_revision: preview.policy_revision,
        file_digest: preview.file_digest,
      },
    });
  }
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The API names requests by UUID, not by the APR- reference shown on screen. */
export const isUuid = (value: string) => uuid.test(value);
