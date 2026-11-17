import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { setTimeout as wait } from "node:timers/promises";
import type { Io } from "./io.ts";

/** Reads a line without echoing it, for a pasted token. */
function askHidden(question: string): Promise<string> {
  const { stdin, stderr } = process;
  stderr.write(question);
  return new Promise((resolve, reject) => {
    let typed = "";
    const done = (finish: () => void) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      stderr.write("\n");
      finish();
    };
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\u0003")
          return done(() => reject(new Error("Cancelled.")));
        if (char === "\r" || char === "\n") return done(() => resolve(typed));
        if (char === "\u007f") typed = typed.slice(0, -1);
        else typed += char;
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

async function ask(question: string, options: { hidden?: boolean } = {}) {
  if (options.hidden && process.stdin.isTTY) return askHidden(question);
  // Questions go to stderr, so stdout stays clean for --json.
  const lines = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    return await lines.question(question);
  } finally {
    lines.close();
  }
}

async function readStdin() {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** The real terminal, file system and network. */
export function terminal(): Io {
  return {
    out: (text) => process.stdout.write(`${text}\n`),
    err: (text) => process.stderr.write(`${text}\n`),
    write: (text) => process.stdout.write(text),
    writeErr: (text) => process.stderr.write(text),
    env: process.env,
    home: homedir(),
    cwd: process.cwd(),
    interactive: Boolean(process.stdin.isTTY && process.stderr.isTTY),
    ask,
    readStdin,
    readFile: (path) => readFile(path, "utf8"),
    writeFile: (path, text) => writeFile(path, text),
    sleep: async (ms) => {
      await wait(ms);
      return true;
    },
    clear: () => {
      if (process.stdout.isTTY) process.stdout.write("\u001b[2J\u001b[H");
    },
  };
}
