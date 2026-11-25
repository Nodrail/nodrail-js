import { execFile, spawn } from "node:child_process";
import {
  readFileSync,
  readdirSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  readHostCredential,
  writeHostCredential,
} from "@nodrail/policy-engine/command-line";
import { holdProjectAsync } from "../src/project/store.ts";
import { expect, test } from "vitest";

const exec = promisify(execFile);
const worker = `
  import fs from "node:fs";
  import { syncBuiltinESMExports } from "node:module";
  import { setTimeout } from "node:timers/promises";
  const [library, folder, stale, mine, other] = process.argv.slice(1);
  const stat = fs.statSync;
  fs.statSync = (path, options) => {
    const observed = stat(path, options);
    if (path === stale && observed) {
      fs.writeFileSync(mine, "");
      const deadline = Date.now() + 5000;
      while (!fs.existsSync(other)) {
        if (Date.now() > deadline) throw new Error("other reclaimer did not inspect stale lock");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    }
    return observed;
  };
  syncBuiltinESMExports();
  const { holdProjectAsync } = await import(library);
  const marker = folder + ".critical";
  try {
    await holdProjectAsync(folder, async () => {
      fs.writeFileSync(marker, "", { flag: "wx" });
      try {
        await setTimeout(300);
        process.stdout.write("acquired");
      } finally {
        fs.unlinkSync(marker);
      }
    });
  } catch (error) {
    if (!String(error).includes("Another nodrail")) throw error;
    process.stdout.write("busy");
  }
`;

test("two reclaimers that saw the same expired instance cannot take each other's lock", async () => {
  const home = mkdtempSync(join(tmpdir(), "nodrail-reclaim-"));
  try {
    const folder = join(home, "enrollment");
    const stale = join(`${folder}.lock`, `${process.pid}-deadbeef`);
    mkdirSync(`${folder}.lock`);
    writeFileSync(stale, "");
    // A reused PID still exists, but this lease was never refreshed.
    utimesSync(stale, 1, 1);
    const library = new URL("../src/project/store.ts", import.meta.url).href;
    const [left, right] = [join(home, "left"), join(home, "right")];
    const reclaim = (mine: string, other: string) =>
      exec(
        process.execPath,
        [
          "--import",
          import.meta.resolve("tsx"),
          "--input-type=module",
          "-e",
          worker,
          library,
          folder,
          stale,
          mine,
          other,
        ],
        {
          env: { ...process.env, HOME: home, USERPROFILE: home },
          timeout: 12_000,
        },
      );
    const results = await Promise.all([
      reclaim(left!, right!),
      reclaim(right!, left!),
    ]);
    expect(results.map(({ stdout }) => stdout).sort()).toEqual([
      "acquired",
      "busy",
    ]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 15_000);

test.skipIf(process.platform === "win32")(
  "a suspended writer cannot rename its staged credential over the next generation",
  async () => {
    const home = mkdtempSync(join(tmpdir(), "nodrail-stopped-"));
    const folder = join(home, "enrollment");
    const library = new URL("../src/project/store.ts", import.meta.url).href;
    const engine = import.meta.resolve("@nodrail/policy-engine/command-line");
    const previous = {
      origin: "https://nodrail.example",
      workspace: "acme",
      environment: "development",
      projectId: "project",
      installationId: "installation",
      credential: `ndr_123456789abc_${"X".repeat(43)}`,
    };
    const next = {
      ...previous,
      credential: `ndr_123456789abd_${"Y".repeat(43)}`,
    };
    await writeHostCredential(home, previous);
    const child = spawn(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        "--input-type=module",
        "-e",
        `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    const [library, engine, folder, home, raw] = process.argv.slice(1);
    const open = fs.openSync;
    const close = fs.closeSync;
    let staged;
    fs.openSync = (path, ...args) => {
      const fd = open(path, ...args);
      if (String(path).startsWith(home + "/.nodrail/hosts/") && String(path).endsWith(".tmp")) staged = fd;
      return fd;
    };
    fs.closeSync = (fd) => {
      close(fd);
      if (fd === staged) {
        const deadline = Date.now() + 8_000;
        const wait = new Int32Array(new SharedArrayBuffer(4));
        process.stdout.write("staged");
        // Freeze this writer, including its heartbeat, until the replacement
        // finishes. The resume file cannot arrive before the wait is armed.
        while (!fs.existsSync(folder + ".resume")) {
          if (Date.now() >= deadline) throw new Error("replacement did not resume the writer");
          Atomics.wait(wait, 0, 0, 5);
        }
      }
    };
    syncBuiltinESMExports();
    const { holdProjectAsync } = await import(library);
    const { writeHostCredential } = await import(engine);
    try {
      await holdProjectAsync(folder, (lock) => writeHostCredential(home, {
        ...JSON.parse(raw),
        credential: "ndr_123456789abe_" + "Z".repeat(43),
      }, { commit: lock.commit, previousGeneration: "123456789abc" }));
      process.exitCode = 1;
    } catch (error) {
      if (!String(error).includes("local write lock expired")) throw error;
    }
    `,
        library,
        engine,
        folder,
        home,
        JSON.stringify(previous),
      ],
      { env: { ...process.env, HOME: home, USERPROFILE: home } },
    );
    const exits = once(child, "close");
    try {
      const [data] = await once(child.stdout, "data", {
        signal: AbortSignal.timeout(5_000),
      });
      expect(data.toString()).toBe("staged");
      const [marker] = readdirSync(`${folder}.lock`);
      utimesSync(join(`${folder}.lock`, marker!), 1, 1);
      await holdProjectAsync(folder, (lock) =>
        writeHostCredential(home, next, {
          commit: lock.commit,
          previousGeneration: "123456789abc",
        }),
      );
      writeFileSync(`${folder}.resume`, "");
      await expect(exits).resolves.toEqual([0, null]);
      expect(await readHostCredential(home, next)).toEqual(next);
      const hosts = join(home, ".nodrail", "hosts");
      const [record] = readdirSync(hosts);
      expect(JSON.parse(readFileSync(join(hosts, record!), "utf8"))).toEqual(
        next,
      );
    } finally {
      child.kill("SIGKILL");
      await exits;
      rmSync(home, { recursive: true, force: true });
    }
  },
  12_000,
);
