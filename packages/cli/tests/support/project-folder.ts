import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeIo } from "./fake-io.ts";

/**
 * A project folder on disk with these files, and `nodrail` run in it.
 * Offline: any network use fails the test.
 */
export function projectFolder(
  files: Record<string, string> = {},
  env?: Record<string, string>,
  /** A stand-in Nodrail, for a test that means to reach one. */
  network?: typeof globalThis.fetch,
) {
  const cwd = mkdtempSync(join(tmpdir(), "nodrail-project-"));
  // The person's home, where nodrail stages writes, the same for every run.
  const home = mkdtempSync(join(tmpdir(), "nodrail-home-"));
  const write = (path: string, text: string) => {
    mkdirSync(join(cwd, path, ".."), { recursive: true });
    writeFileSync(join(cwd, path), text);
  };
  for (const [path, text] of Object.entries(files)) write(path, text);
  const fetch =
    network ??
    ((() => {
      throw new Error("network used");
    }) as unknown as typeof globalThis.fetch);
  const read = (path: string) => readFileSync(join(cwd, path), "utf8");
  /** `nodrail` run in another folder, as `nodrail plan ./project` is. */
  const runFrom = async (from: string, ...argv: string[]) => {
    const terminal = fakeIo({ cwd: from, home, fetch, env });
    const code = await terminal.run(...argv);
    return { code, out: terminal.stdout(), err: terminal.stderr() };
  };
  const run = (...argv: string[]) => runFrom(cwd, ...argv);
  /** `nodrail` run here with this on stdin, as a host runs a hook. */
  const runWith = async (
    { stdin, self }: { stdin: string; self?: string[] },
    ...argv: string[]
  ) => {
    const terminal = fakeIo({ cwd, home, fetch, env, stdin, self });
    const code = await terminal.run(...argv);
    return { code, out: terminal.stdout(), err: terminal.stderr() };
  };
  return { cwd, home, read, write, run, runFrom, runWith };
}
