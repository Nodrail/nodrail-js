// The nodrail-policy command line run in-process, with its output captured.
import { runCli, type Io } from "../src/command-line.ts";

export async function cli(args: string[], stdin = "") {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    log: (text) => out.push(`${text}\n`),
    error: (text) => err.push(`${text}\n`),
    write: (text) => out.push(text),
    writeError: (text) => err.push(text),
    readStdin: async () => stdin,
  };
  const code = await runCli(args, io);
  return { code, stdout: out.join(""), stderr: err.join("") };
}
