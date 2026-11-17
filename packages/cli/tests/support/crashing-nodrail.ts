// `nodrail` in a process that dies at one step of writing the project, the
// way a killed process or a power cut would: no `finally`, no cleanup.
// CRASH_ON=rename:<n> dies before the nth file is moved into place;
// CRASH_ON=ready dies before the write is marked complete.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const [step, nth] = (process.env.CRASH_ON ?? "").split(":");
const die = () => process.exit(9);
const { renameSync, writeFileSync } = fs;
let renames = 0;
fs.renameSync = (from, to) => {
  renames += 1;
  if (step === "rename" && renames === Number(nth)) die();
  renameSync(from, to);
};
fs.writeFileSync = ((path, ...rest) => {
  if (step === "ready" && String(path).endsWith("ready")) die();
  (writeFileSync as (...args: unknown[]) => void)(path, ...rest);
}) as typeof fs.writeFileSync;
syncBuiltinESMExports();

const { main } = await import("../../src/cli.ts");
const { terminal } = await import("../../src/terminal.ts");
process.exitCode = await main(process.argv.slice(2), terminal());
