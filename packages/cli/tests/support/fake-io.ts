import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../../src/cli.ts";
import type { Io } from "../../src/io.ts";

type Setup = {
  fetch?: typeof fetch;
  env?: Record<string, string>;
  interactive?: boolean;
  /** Answers to questions, in order. */
  answers?: string[];
  stdin?: string;
  files?: Record<string, string>;
  /** How many polls `--watch` makes before it stops. */
  polls?: number;
  home?: string;
  cwd?: string;
};

/** A terminal in memory, with its own empty home folder. */
export function fakeIo(setup: Setup = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const asked: { question: string; hidden: boolean }[] = [];
  const answers = [...(setup.answers ?? [])];
  const files = new Map(Object.entries(setup.files ?? {}));
  let polls = setup.polls ?? 0;
  let clears = 0;
  // Exactly what reached stdout and stderr, newlines included.
  let stdoutBytes = "";
  let stderrBytes = "";
  const io: Io = {
    out: (text) => {
      out.push(text);
      stdoutBytes += `${text}\n`;
    },
    err: (text) => {
      err.push(text);
      stderrBytes += `${text}\n`;
    },
    write: (text) => {
      out.push(text);
      stdoutBytes += text;
    },
    writeErr: (text) => {
      err.push(text);
      stderrBytes += text;
    },
    env: setup.env ?? {},
    home: setup.home ?? mkdtempSync(join(tmpdir(), "nodrail-cli-")),
    cwd: setup.cwd ?? mkdtempSync(join(tmpdir(), "nodrail-project-")),
    fetch: setup.fetch,
    interactive: setup.interactive ?? false,
    ask: async (question, options) => {
      asked.push({ question, hidden: Boolean(options?.hidden) });
      return answers.shift() ?? "";
    },
    readStdin: async () => setup.stdin ?? "",
    readFile: async (path) => {
      const text = files.get(path);
      if (text === undefined) throw new Error(`ENOENT: ${path}`);
      return text;
    },
    writeFile: async (path, text) => {
      files.set(path, text);
    },
    sleep: async () => {
      polls -= 1;
      return polls > 0;
    },
    clear: () => {
      clears += 1;
    },
  };
  return {
    io,
    out,
    err,
    asked,
    files,
    clears: () => clears,
    run: (...argv: string[]) => main(argv, io),
    stdout: () => out.join("\n"),
    stderr: () => err.join("\n"),
    bytes: () => ({ stdout: stdoutBytes, stderr: stderrBytes }),
  };
}
