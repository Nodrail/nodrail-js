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
    "src/actions.ts",
  ],
  outdir: "dist",
});

await build({
  ...shared,
  entryPoints: ["src/cli.ts"],
  outfile: "dist/cli.js",
  banner: { js: "#!/usr/bin/env node" },
});
