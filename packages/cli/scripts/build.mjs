import { rmSync } from "node:fs";
import { build } from "esbuild";

rmSync("dist", { recursive: true, force: true });

const shared = { platform: "node", format: "esm", target: "node22" };

// The library: its index and the API client, which @nodrail/mcp imports.
await build({
  ...shared,
  entryPoints: ["src/index.ts", "src/api.ts"],
  outdir: "dist",
  bundle: true,
  packages: "external",
});

// The command is one file with no dependencies: the policy engine, yaml and
// zod are inside it. yaml is CommonJS and requires Node's modules, which an
// ES module can only do through createRequire.
await build({
  ...shared,
  entryPoints: ["src/bin.ts"],
  outfile: "dist/nodrail.mjs",
  bundle: true,
  banner: {
    js: [
      "#!/usr/bin/env node",
      'import { createRequire as __nodrailRequire } from "node:module";',
      "const require = __nodrailRequire(import.meta.url);",
    ].join("\n"),
  },
});
