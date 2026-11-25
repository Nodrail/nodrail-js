import { spawn, type SpawnOptions } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { looksLikeSession } from "../config.ts";
import type { Command } from "../context.ts";
import { CliError } from "../io.ts";

type BrowserLaunch = (
  program: string,
  args: string[],
  options: SpawnOptions,
) => {
  on(event: "error", listener: () => void): unknown;
  unref(): void;
};

export function openBrowser(
  url: string,
  platform = process.platform,
  launch: BrowserLaunch = spawn,
) {
  const [program, ...args] =
    platform === "darwin"
      ? ["open", url]
      : platform === "win32"
        ? ["rundll32.exe", "url.dll,FileProtocolHandler", url]
        : ["xdg-open", url];
  const child = launch(program!, args, { stdio: "ignore", detached: true });
  child.on("error", () => {
    // The login URL is also available in the terminal.
  });
  child.unref();
}

export async function browserLogin({ io, url }: Command) {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("hex");
  const path = `${url}/api/v1/cli/login`;
  async function request(endpoint: string, body: object) {
    const response = await (io.fetch ?? fetch)(`${path}/${endpoint}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ origin: url, ...body }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok)
      throw new CliError(
        `CLI login at ${url} returned HTTP ${response.status}. Run nodrail login --url ${url} to start again.`,
      );
    return (await response.json()) as { token?: string; pending?: true };
  }

  await request("start", { challenge });
  const browserUrl = `${path}/approve/${challenge}`;
  io.err(`Open ${browserUrl} and confirm the code ${challenge.slice(0, 8)}.`);
  (io.openBrowser ?? openBrowser)(browserUrl);
  for (let attempt = 0; attempt < 150; attempt++) {
    const result = await request("exchange", { verifier });
    if (result.token && looksLikeSession(result.token)) return result.token;
    if (!result.pending || !(await io.sleep(2000))) break;
  }
  throw new CliError(
    `CLI login did not finish. Run nodrail login --url ${url} to start again.`,
  );
}
