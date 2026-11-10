import { rmSync } from "node:fs";
import { build } from "esbuild";

rmSync("dist", { recursive: true, force: true });

const shared = { platform: "node", format: "esm", target: "node22" };

// The library leaves its dependencies to the installer.
await build({
  ...shared,
  entryPoints: ["src/index.ts", "src/protocol.ts", "src/langchain.ts", "src/setup.ts"],
  outdir: "dist",
  bundle: true,
  packages: "external",
});

// The hook is one file, so a broken dependency cannot stop it blocking.
await build({
  ...shared,
  entryPoints: ["src/hook-main.ts"],
  outfile: "dist/nodrail-hook.mjs",
  bundle: true,
  banner: { js: "#!/usr/bin/env node" },
});
