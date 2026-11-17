import { main } from "./cli.ts";
import { terminal } from "./terminal.ts";

process.exitCode = await main(process.argv.slice(2), terminal());
