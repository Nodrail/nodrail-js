import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Real git, Node and CLI subprocesses can take longer on shared runners.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["src/**"],
      // Cover executable source, excluding the real terminal and entry.
      exclude: ["src/**/*.d.ts", "src/bin.ts", "src/terminal.ts"],
      reporter: ["text-summary"],
      // Thresholds apply where all supported hosts are exercised.
      thresholds:
        process.platform === "win32"
          ? undefined
          : { statements: 90, branches: 80, functions: 90, lines: 90 },
    },
  },
});
