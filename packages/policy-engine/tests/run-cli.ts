// The nodrail-policy command line run in-process, with its output captured.
import { fileURLToPath } from "node:url";
import { runPolicyCommandLine, type Io } from "../src/command-line.ts";

/** The command line itself, for the hook's sender: never the test runner. */
export const self = [
  "--import",
  "tsx",
  fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
];

export async function cli(args: string[], stdin = "") {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    log: (text) => out.push(`${text}\n`),
    error: (text) => err.push(`${text}\n`),
    write: (text) => out.push(text),
    writeError: (text) => err.push(text),
    readStdin: async () => stdin,
    self,
  };
  const code = await runPolicyCommandLine(args, io);
  return { code, stdout: out.join(""), stderr: err.join("") };
}
