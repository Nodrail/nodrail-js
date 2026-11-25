import { rmSync } from "node:fs";
import { build } from "esbuild";

rmSync("dist", { recursive: true, force: true });

const shared = { platform: "node", format: "esm", target: "node22" };

// The library leaves its dependencies to the installer.
await build({
  ...shared,
  entryPoints: [
    "src/index.ts",
    "src/protocol.ts",
    "src/langchain.ts",
    "src/setup.ts",
    "src/hooks.ts",
  ],
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
  minifySyntax: true,
  banner: { js: "#!/usr/bin/env node" },
});

// The SDK's brief and input checker, which the hook loads only for a call a
// declared contract covers (.nodrail/contracts.json): one file with the
// engine, yaml and zod inside, so the hook itself stays small. yaml is
// CommonJS and requires Node's modules, which an ES module can only do
// through createRequire.
await build({
  ...shared,
  entryPoints: ["src/contract-fields.ts"],
  outfile: "dist/nodrail-hook-contracts.mjs",
  bundle: true,
  banner: {
    js: [
      'import { createRequire as __nodrailRequire } from "node:module";',
      "const require = __nodrailRequire(import.meta.url);",
    ].join("\n"),
  },
});
