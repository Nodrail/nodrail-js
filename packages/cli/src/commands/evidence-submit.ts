// `nodrail evidence submit <name> --result <file>`: from a
// GitHub Actions job, externally verified evidence for Cloud. It asks
// Actions for an OIDC token whose audience is this workspace
// (`<url>/w/<workspace>`) and posts the value with it; Cloud checks the
// token against a verifier, ties the commit to the subject and validates
// the value against the published contract. Nothing here is a Nodrail
// token. Retries send the same body, which Cloud answers idempotently.
// Exit codes: 0 stored, 3 refused, 4 Cloud not reached.
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { checkValue, PAYLOAD_BYTES } from "@nodrail/policy-engine/contracts";
import { isUuid, visible } from "../api.ts";
import { resolveUrl } from "../config.ts";
import { CliError, UsageError, type Io } from "../io.ts";
import { contractOf, parseEvidenceArgs, short } from "./evidence-shared.ts";
import { policyHere } from "./policy-here.ts";

/** Exit codes of `submit`: stored, refused by Cloud, Cloud not reached. */
export const SUBMIT_EXIT = { stored: 0, rejected: 3, unreachable: 4 } as const;

/** Waits between attempts; each retry sends the same body. */
const RETRY_DELAYS_MS = [1000, 3000];

/** The OIDC token GitHub Actions issues this job for `audience`. */
async function actionsToken(io: Io, audience: string, fetcher: typeof fetch) {
  const url = io.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const token = io.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !token)
    throw new CliError(
      "No GitHub Actions OIDC token here: run this in a GitHub Actions job with `permissions: id-token: write`.",
    );
  const target = new URL(url);
  target.searchParams.set("audience", audience);
  let response: Response;
  try {
    response = await fetcher(target, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    });
  } catch (error) {
    throw new CliError(
      `GitHub Actions didn't issue an OIDC token: ${(error as Error).message}`,
    );
  }
  const body = (await response.json().catch(() => null)) as {
    value?: unknown;
  } | null;
  if (!response.ok || typeof body?.value !== "string" || !body.value)
    throw new CliError(
      `GitHub Actions didn't issue an OIDC token (HTTP ${response.status}). Does the job have \`permissions: id-token: write\`?`,
    );
  return body.value;
}

/** The commit CI built: GITHUB_SHA, else HEAD. */
function commitOf(io: Io) {
  const sha = io.env.GITHUB_SHA?.trim();
  if (sha) return sha;
  const head = spawnSync("git", ["rev-parse", "--verify", "HEAD"], {
    cwd: io.cwd,
    encoding: "utf8",
  });
  if (head.status !== 0)
    throw new CliError("No commit: set GITHUB_SHA or run this in a checkout.");
  return head.stdout.trim();
}

type Values = ReturnType<typeof parseEvidenceArgs>["values"];

/** The workspace, environment and event key, from flags or the job's env. */
function target(values: Values, io: Io) {
  const workspace = values.workspace ?? io.env.NODRAIL_WORKSPACE;
  const environment = values.environment ?? io.env.NODRAIL_ENVIRONMENT;
  if (!workspace || !isUuid(workspace))
    throw new UsageError(
      "--workspace (or NODRAIL_WORKSPACE) must be the workspace's id, a UUID.",
    );
  if (!environment)
    throw new UsageError(
      "-e (or NODRAIL_ENVIRONMENT) names the environment the evidence is for.",
    );
  const key = values.key ?? "default";
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(key))
    throw new UsageError("--key is 1 to 64 letters, digits, dot, dash or _.");
  return { workspace, environment, key };
}

/** The result file: one JSON object of at most 16 KiB. */
function readValue(io: Io, path: string) {
  const file = resolve(io.cwd, path);
  if (statSync(file).size > PAYLOAD_BYTES.evidence)
    throw new CliError(`${path} is over 16 KiB.`);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new CliError(`${path} isn't JSON.`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new CliError(`${path} must hold one JSON object.`);
  return value as Record<string, unknown>;
}

type Answer = {
  id?: string;
  subject?: string;
  validation?: string;
  issues?: { path: string | null; code: string }[];
  replayed?: boolean;
  error?: { code?: string; request_id?: string };
};

/** One attempt: Cloud's answer, or why it couldn't be reached. */
async function post(
  fetcher: typeof fetch,
  url: string,
  jwt: string,
  body: string,
): Promise<Response | string> {
  try {
    const response = await fetcher(`${url}/api/v1/evidence`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${jwt}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body,
      redirect: "error",
    });
    // Worth another try: the server or GitHub's keys were busy.
    if (response.status >= 500 || response.status === 429)
      return `HTTP ${response.status}`;
    return response;
  } catch (error) {
    return (error as Error).message;
  }
}

/** Why Cloud refused, by its code; never a value. */
function refusedText(name: string, status: number, answer: Answer | null) {
  const code = answer?.error?.code ?? `HTTP_${status}`;
  const request = answer?.error?.request_id;
  return `nodrail: Cloud refused ${name}: ${code}${request ? ` (request ${request})` : ""}.`;
}

/** What Cloud stored: the subject, validation state and issues by path. */
function storedText(name: string, answer: Answer | null) {
  const issues = answer?.issues?.length
    ? ` (${answer.issues.map((i) => `${i.path ?? "(value)"}: ${i.code}`).join(", ")})`
    : "";
  const replayed = answer?.replayed ? ", already stored" : "";
  return `Stored ${name} for ${short(answer?.subject)}: ${answer?.validation ?? "?"}${issues}${replayed}, event ${answer?.id ?? "?"}.`;
}

/** What Cloud said, to the person; the exit code. */
async function answered(
  response: Response,
  name: string,
  io: Io,
  json: boolean,
) {
  const answer = (await response.json().catch(() => null)) as Answer | null;
  if (!response.ok) {
    io.err(visible(refusedText(name, response.status, answer)));
    return SUBMIT_EXIT.rejected;
  }
  if (json) io.out(JSON.stringify(answer, null, 2));
  else io.out(visible(storedText(name, answer)));
  return SUBMIT_EXIT.stored;
}

export async function submit(rest: string[], io: Io) {
  const { values, positionals } = parseEvidenceArgs(rest);
  const [name, extra] = positionals;
  if (!name || extra !== undefined || !values.result)
    throw new UsageError(
      "Usage: nodrail evidence submit <name> --result <file> --workspace <id> -e <environment>",
    );
  const { workspace, environment, key } = target(values, io);
  const document = policyHere({ cwd: io.cwd, home: io.home, ...values });
  const contract = contractOf(document, name, "externally-verified");
  const value = readValue(io, values.result);
  // Cloud validates again against the published contract; this says early.
  const checked = checkValue(contract.shape, value, PAYLOAD_BYTES.evidence);
  if (checked.state === "invalid")
    io.err(
      `nodrail: ${values.result} doesn't follow the ${name} contract (${checked.issues.map((i) => `${i.path}: ${i.code}`).join(", ")}); Cloud records it as invalid.`,
    );
  const url = resolveUrl(io.env, values.url);
  const fetcher = io.fetch ?? fetch;
  const jwt = await actionsToken(io, `${url}/w/${workspace}`, fetcher);
  const body = JSON.stringify({
    workspace,
    environment,
    evidence: name,
    event_key: key,
    commit: commitOf(io),
    contract: contract.contract,
    value,
  });
  let last = "";
  for (const delay of [...RETRY_DELAYS_MS, null]) {
    const response = await post(fetcher, url, jwt, body);
    if (typeof response !== "string")
      return answered(response, name, io, Boolean(values.json));
    last = response;
    if (delay !== null) await io.sleep(delay);
  }
  io.err(visible(`nodrail: couldn't reach ${url} to submit ${name}: ${last}.`));
  return SUBMIT_EXIT.unreachable;
}
