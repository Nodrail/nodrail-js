import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**"],
      // Process wiring around the tested modules: the real terminal and entry.
      exclude: ["src/bin.ts", "src/terminal.ts"],
      reporter: ["text-summary"],
      // Measured where the whole suite runs. On Windows the Codex tests are
      // skipped, as Codex isn't set up there, so the rest runs unmeasured.
      thresholds:
        process.platform === "win32"
          ? undefined
          : { statements: 90, branches: 80, functions: 90, lines: 90 },
    },
  },
});
