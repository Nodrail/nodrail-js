import { spawn } from "node:child_process";
import type { Env } from "../config.ts";

/** A JSON-RPC message, as servers on stdio send them, one per line. */
export type Message = {
  id?: number;
  result?: unknown;
  error?: { message?: string };
};

/**
 * Starts a server that speaks JSON lines on stdio, sends the first message,
 * and hands each answer to `answer`, which sends more or finishes with a
 * value, or throws to fail. The server is stopped when it finishes, fails,
 * or takes too long.
 */
export function askServer<T>(input: {
  command: string;
  args: string[];
  cwd: string;
  env: Env;
  timeout: number;
  first: object;
  answer: (
    message: Message,
    send: (message: object) => void,
    finish: (value: T) => void,
  ) => void;
}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const server = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: input.env as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "ignore"],
      shell: process.platform === "win32",
    });
    let settled = false;
    const done = (error: Error | null, value?: T) => {
      // Stopping the server below ends it too: answer once.
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.kill();
      if (error) reject(error);
      else resolve(value as T);
    };
    const timer = setTimeout(
      () => done(new Error(`no answer in ${input.timeout / 1000} seconds`)),
      input.timeout,
    );
    const send = (message: object) =>
      server.stdin.write(`${JSON.stringify(message)}\n`);
    server.on("error", (error) => done(error));
    server.on("exit", (code) =>
      done(new Error(`it stopped${code === null ? "" : ` (exit ${code})`}`)),
    );
    server.stdin.on("error", () => undefined);
    let buffer = "";
    server.stdout.on("data", (data: Buffer) => {
      buffer += data.toString("utf8");
      let at: number;
      while ((at = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        let message: Message;
        try {
          message = JSON.parse(line) as Message;
        } catch {
          continue;
        }
        try {
          input.answer(message, send, (value) => done(null, value));
        } catch (error) {
          done(error as Error);
        }
      }
    });
    send(input.first);
  });
}
