import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CliError } from "../io.ts";

const uuid = /^[0-9a-f-]{36}$/i;

const pathOf = (home: string) => join(home, ".nodrail", "machine-id");

/** Read-only during plan; the id outlives a missing credential file. */
export async function readMachineId(home: string) {
  let id: string;
  try {
    id = (await readFile(pathOf(home), "utf8")).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!uuid.test(id))
    throw new CliError("Invalid Nodrail machine id in ~/.nodrail/machine-id.");
  return id;
}

export async function saveMachineId(home: string, id: string) {
  const path = pathOf(home);
  const temporary = `${path}.${randomUUID()}.tmp`;
  await mkdir(join(home, ".nodrail"), { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporary, `${id}\n`, { mode: 0o600, flag: "wx" });
    await link(temporary, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if ((await readMachineId(home)) !== id)
      throw new CliError(
        "Another apply initialized this machine. Run nodrail apply again.",
      );
  } finally {
    await rm(temporary, { force: true });
  }
}
