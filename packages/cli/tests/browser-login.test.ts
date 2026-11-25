import { EventEmitter } from "node:events";
import { expect, test, vi } from "vitest";
import { openBrowser } from "../src/commands/browser-login.ts";

const url = "https://nodrail.example/api/v1/cli/login/approve/fixture";

test.each([
  ["darwin", "open", [url]],
  ["linux", "xdg-open", [url]],
  ["win32", "rundll32.exe", ["url.dll,FileProtocolHandler", url]],
] as const)("opens the login URL on %s with %s", (platform, program, args) => {
  const unref = vi.fn();
  const child = Object.assign(new EventEmitter(), { unref });
  const launch = vi.fn(() => child);
  openBrowser(url, platform, launch);
  expect(launch).toHaveBeenCalledWith(program, args, {
    detached: true,
    stdio: "ignore",
  });
  expect(unref).toHaveBeenCalledOnce();
  expect(() => child.emit("error", new Error("no browser"))).not.toThrow();
});
