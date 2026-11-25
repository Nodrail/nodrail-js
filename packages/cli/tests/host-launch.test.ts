import { accessSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { expect, it, vi } from "vitest";

const { parse } = vi.hoisted(() => ({ parse: vi.fn() }));
vi.mock("cross-spawn", () => ({ default: { _parse: parse } }));
vi.mock("node:fs", async (original) => ({
  ...(await original<typeof import("node:fs")>()),
  accessSync: vi.fn(),
}));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawnSync: vi.fn(),
}));

it("probes an uppercase Windows batch launcher with a short path and a hosts-only PATH", async () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const launcher =
    "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\hosts\\claude.CMD";
  const env = {
    PATH: launcher.slice(0, -"\\claude.CMD".length),
    PATHEXT: ".CMD",
  };
  const cmd = "C:\\Windows\\System32\\cmd.exe";
  const args = ["/d", "/s", "/c", `"${launcher} ^"--version^""`];

  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  vi.stubEnv("ComSpec", undefined);
  vi.stubEnv("SystemRoot", "C:\\Windows");
  try {
    const { versionCheck } = await import("../src/setup/tools.ts");
    parse.mockImplementation((_command, _args, options) => ({
      command: "cmd.exe",
      args,
      options: { ...options, windowsVerbatimArguments: true },
    }));
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: "2.1.328 (Claude Code)\r\n",
      stderr: "",
      output: [],
      pid: 1,
      signal: null,
    });

    expect(
      versionCheck("claude", "2.1.300", "install Claude Code", env),
    ).toEqual({
      name: "claude",
      ok: true,
      detail: "2.1.328",
    });
    expect(accessSync).toHaveBeenCalledWith(launcher, expect.any(Number));
    expect(parse).toHaveBeenCalledWith(
      launcher,
      ["--version"],
      expect.anything(),
    );
    expect(spawnSync).toHaveBeenCalledWith(
      cmd,
      args,
      expect.objectContaining({
        env,
        windowsVerbatimArguments: true,
      }),
    );
  } finally {
    Object.defineProperty(process, "platform", platform);
    vi.unstubAllEnvs();
  }
});
