import { describe, expect, test } from "vitest";
import {
  ApiError,
  isUuid,
  NodrailApi,
  withoutTrailingSlashes,
} from "../src/api.ts";
import { RUN_ID, TOKEN, fakeApi } from "./support/fake-api.ts";

describe("NodrailApi", () => {
  test("sends the bearer token and the environment, trims the URL", async () => {
    const api = fakeApi();
    const client = new NodrailApi({
      token: TOKEN,
      url: "https://nodrail.example/",
      environment: "production",
      fetch: api.fetch,
    });
    expect(client.url).toBe("https://nodrail.example");
    await client.me();
    expect(api.seen.at(-1)?.query).toEqual({});
    await client.activity({ agent: "" });
    expect(api.seen.at(-1)?.query).toEqual({ environment: "production" });
  });

  test("errors carry status, code and request id", async () => {
    const client = new NodrailApi({ token: "bad", fetch: fakeApi().fetch });
    const error = await client.run(RUN_ID).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 401,
      code: "UNAUTHENTICATED",
      requestId: "req-1",
    });
  });

  test("an answer that isn't JSON still becomes an ApiError", async () => {
    const client = new NodrailApi({
      token: TOKEN,
      fetch: (async () =>
        new Response("<html>", { status: 502 })) as typeof fetch,
    });
    await expect(client.me()).rejects.toMatchObject({
      code: "HTTP_502",
      requestId: null,
    });
  });

  test("isUuid", () => {
    expect(isUuid(RUN_ID)).toBe(true);
    expect(isUuid("APR-6D1C2F0A")).toBe(false);
  });
});

describe("withoutTrailingSlashes", () => {
  test("removes every slash at the end, and only there", () => {
    expect(withoutTrailingSlashes("https://a.test/x///")).toBe(
      "https://a.test/x",
    );
    expect(withoutTrailingSlashes("https://a.test")).toBe("https://a.test");
    expect(withoutTrailingSlashes("///")).toBe("");
  });

  test("takes time in proportion to the URL, however many slashes", () => {
    const long = `${"/".repeat(200_000)}x`;
    const started = performance.now();
    withoutTrailingSlashes(long);
    expect(performance.now() - started).toBeLessThan(200);
  });
});
