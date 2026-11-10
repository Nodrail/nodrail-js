// The source imports its own .ts files, which every tool here understands. The
// published declarations sit beside .js files, so their relative imports must
// say .js for Node's resolution (moduleResolution nodenext) to find them.
//
//   node scripts/declarations.mjs <dist folder>
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [folder = "dist"] = process.argv.slice(2);
for (const name of readdirSync(folder).filter((file) => file.endsWith(".d.ts"))) {
  const path = join(folder, name);
  const text = readFileSync(path, "utf8");
  // Both `from "./x.ts"` and inline `import("./x.ts")` type references.
  const fixed = text.replace(
    /((?:from\s+|import\(\s*)["']\.\.?\/[^"']+)\.ts(["'])/g,
    "$1.js$2",
  );
  if (fixed !== text) writeFileSync(path, fixed);
}
