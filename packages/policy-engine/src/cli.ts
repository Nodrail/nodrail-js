// The nodrail-policy command. Everything it does is in command-line.ts.
import { processIo, runPolicyCommandLine } from "./command-line.ts";

process.exitCode = await runPolicyCommandLine(process.argv.slice(2), processIo);
