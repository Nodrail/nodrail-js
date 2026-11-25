import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    pool: "forks",
    include: ["tests/**/*.test.ts"],
    // Real git, Node and CLI subprocesses can take longer on shared runners.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // A little under today's coverage, so a real drop fails CI.
    coverage: {
      provider: "v8",
      include: ["src/**"],
      // The process entry point only wires up the tested module; tests that
      // run it as a separate process cover it, but aren't measured.
      exclude: ["src/cli.ts"],
      reporter: ["text-summary"],
      thresholds: { statements: 94, branches: 90, functions: 94, lines: 95 },
    },
  },
});
