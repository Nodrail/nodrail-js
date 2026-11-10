// The nodrail-policy command. Everything it does is in command-line.ts.
import { processIo, runCli } from "./command-line.ts";

runCli(process.argv.slice(2), processIo).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  },
);
