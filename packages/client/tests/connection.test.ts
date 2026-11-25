import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { DEFAULT_URL, type Environment } from "../src/connection";
import { runHook } from "../src/hooks";
import { createNodrail, type NodrailOptions } from "../src/sdk";
import { fakeNodrail } from "./support/fake-nodrail";

const credential = "fixture-secret";
const origin = "https://issuer.example";
const equivalent = "https://ISSUER.Example:443/";
const foreign = "https://other.example";
const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

function saved(url?: string) {
  const home = mkdtempSync(join(tmpdir(), "nodrail-origin-"));
  homes.push(home);
  writeFileSync(join(home, "credential"), credential);
  if (url !== undefined) writeFileSync(join(home, "url"), url);
  return { NODRAIL_HOME: home };
}

const invoke = (options: NodrailOptions, fetch: typeof globalThis.fetch) =>
  createNodrail({ ...options, fetch }).guard(() => "executed", {
    name: "send",
  })();

function expectBearer(
  fetch: ReturnType<typeof vi.fn<typeof globalThis.fetch>>,
  url: string,
) {
  const [input, init] = fetch.mock.calls[0]!;
  expect(new URL(input instanceof Request ? input.url : input).origin).toBe(
    url,
  );
  expect(new Headers(init?.headers).get("authorization")).toBe(
    `Bearer ${credential}`,
  );
}

test("an explicit SDK URL cannot borrow an unpaired environment credential", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  await expect(
    invoke({ url: foreign, env: { NODRAIL_CREDENTIAL: credential } }, fetch),
  ).resolves.toContain("Pair NODRAIL_URL");
  expect(fetch).not.toHaveBeenCalled();
});

test("a plugin URL cannot borrow an unpaired environment credential", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  const result = await runHook(
    JSON.stringify({ hook_event_name: "SessionStart" }),
    { NODRAIL_CREDENTIAL: credential, CLAUDE_PLUGIN_OPTION_URL: foreign },
    { fetch },
  );
  expect(result.stdout).toContain("Pair NODRAIL_URL");
  expect(fetch).not.toHaveBeenCalled();
});

test.each([
  [
    "environment",
    () => ({ NODRAIL_URL: equivalent, NODRAIL_CREDENTIAL: credential }),
    origin,
  ],
  [
    "plugin",
    () => ({
      CLAUDE_PLUGIN_OPTION_URL: equivalent,
      CLAUDE_PLUGIN_OPTION_CREDENTIAL: credential,
    }),
    origin,
  ],
  ["saved fixture", () => saved(equivalent), origin],
  ["legacy Cloud fixture", () => saved(), DEFAULT_URL],
] satisfies [string, () => Environment, string][])(
  "uses the canonical origin of the %s credential",
  async (_label, environment, url) => {
    const fetch = vi.fn(fakeNodrail().fetch);
    await expect(invoke({ url, env: environment() }, fetch)).resolves.toBe(
      "executed",
    );
    expectBearer(fetch, url);
  },
);

test.each([
  () => ({ url: foreign, env: saved() }),
  () => ({ env: { ...saved(), NODRAIL_URL: foreign } }),
  () => ({ env: { ...saved(), CLAUDE_PLUGIN_OPTION_URL: foreign } }),
  () => ({ url: foreign, env: saved(equivalent) }),
  () => ({ env: saved("https://issuer.example/path") }),
] satisfies (() => NodrailOptions)[])(
  "rejects mismatched URLs and invalid saved URLs",
  async (options) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(invoke(options(), fetch)).resolves.toContain(
      "Pair NODRAIL_URL",
    );
    expect(fetch).not.toHaveBeenCalled();
  },
);

test.each([
  { url: origin, credential: "" },
  { credential },
  { url: "https://issuer.example/path" },
])("rejects invalid or incomplete SDK overrides", async (options) => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  const env = { NODRAIL_URL: origin, NODRAIL_CREDENTIAL: credential };
  await expect(invoke({ ...options, env }, fetch)).resolves.toContain(
    "Pair NODRAIL_URL",
  );
  expect(fetch).not.toHaveBeenCalled();
});

test("an empty saved credential does not configure the SDK", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  const env = saved(equivalent);
  writeFileSync(join(env.NODRAIL_HOME, "credential"), "\n");
  await expect(invoke({ env }, fetch)).resolves.toContain("not configured");
  expect(fetch).not.toHaveBeenCalled();
});

test("an explicit SDK pair supplies its own credential", async () => {
  const fetch = vi.fn(fakeNodrail().fetch);
  await expect(
    invoke(
      { url: equivalent, credential, env: { NODRAIL_CREDENTIAL: "unpaired" } },
      fetch,
    ),
  ).resolves.toBe("executed");
  expectBearer(fetch, origin);
});
