import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
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
