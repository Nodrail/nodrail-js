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
      exclude: ["src/hook-main.ts"],
      reporter: ["text-summary"],
      thresholds: { statements: 97, branches: 92, functions: 97, lines: 97 },
    },
  },
});
