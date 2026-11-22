// The nodrail-policy command line run in-process, with its output captured.
import { fileURLToPath } from "node:url";
import { runPolicyCommandLine, type Io } from "../src/command-line.ts";

/** The command line itself, for the hook's sender: never the test runner. */
export const self = [
  "--import",
  "tsx",
  fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
];

/**
 * Makes `home` the person's home (HOME on Unix, USERPROFILE on Windows,
 * which `os.homedir()` reads there). Answers what puts it back.
 */
export function homeAt(home: string) {
  const saved = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
  };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return () => {
    for (const [name, value] of Object.entries(saved))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  };
}

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
