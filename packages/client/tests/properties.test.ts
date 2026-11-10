// Properties the client must keep for any input, over generated cases.
import fc from "fast-check";
import { describe, expect, test, vi } from "vitest";
import { createNodrail } from "../src/index.js";
import { fakeNodrail } from "./support/fake-nodrail.js";

const runs = { numRuns: 200 };

describe("whatever a tool is given", () => {
  test("with no credential, it never runs", async () => {
    const nodrail = createNodrail({
      env: { NODRAIL_HOME: "/nonexistent" },
      waitMs: 0,
    });
    const work = vi.fn((_input: unknown) => "ran");
    const send = nodrail.guard(work, { name: "send" });
    await fc.assert(
      fc.asyncProperty(fc.anything(), async (input) => {
        await send(input);
      }),
      runs,
    );
    expect(work).not.toHaveBeenCalled();
  });

  test("when Nodrail denies it, it never runs", async () => {
    const server = fakeNodrail(() => "DENIED");
    const nodrail = createNodrail({
      url: "https://nodrail.test",
      credential: "c",
      waitMs: 0,
      fetch: server.fetch,
      env: {},
    });
    const work = vi.fn((_input: unknown) => "ran");
    const tools = nodrail.guard({ send: { name: "send", execute: work } });
    await fc.assert(
      fc.asyncProperty(fc.jsonValue(), async (input) => {
        await (
          tools.send.execute as unknown as (input: unknown) => Promise<unknown>
        )(input);
      }),
      runs,
    );
    expect(work).not.toHaveBeenCalled();
  });
});
