import { rmSync } from "node:fs";
import { build } from "esbuild";

rmSync("dist", { recursive: true, force: true });

const shared = {
  platform: "node",
  format: "esm",
  target: "node22",
  bundle: true,
  packages: "external",
};

await build({
  ...shared,
  entryPoints: [
    "src/index.ts",
    "src/protocol.ts",
    "src/simulator.ts",
    "src/yaml.ts",
    "src/compile.ts",
    "src/actions.ts",
    "src/receipts.ts",
    "src/hook-runs.ts",
    "src/command-line.ts",
    "src/shapes/index.ts",
    "src/shapes/values.ts",
    "src/files/index.ts",
    "src/revision.ts",
    "src/run-ledger.ts",
  ],
  outdir: "dist",
});

await build({
  ...shared,
  entryPoints: ["src/cli.ts"],
  outfile: "dist/cli.js",
  banner: { js: "#!/usr/bin/env node" },
});
