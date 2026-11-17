import { isMap, isScalar, isSeq, parseDocument, YAMLSeq } from "yaml";
import { CliError } from "../io.ts";

/** A new project's manifest, before its first import. */
export const NEW_MANIFEST = `# This repository's Nodrail policy: the modules it uses, in order. Give
# values under \`with\`, then run \`nodrail policy lock\` to review and record
# what changes.
kind: nodrail.project/v1
imports: []
`;

/** The `ref` of one manifest entry, written as a string or as `ref:`. */
function refOf(item: unknown) {
  if (isScalar(item) && typeof item.value === "string") return item.value;
  if (isMap(item)) {
    const ref = item.get("ref");
    if (typeof ref === "string") return ref;
  }
  return null;
}

/**
 * The manifest with `entry` added at the end of its imports, edited in place
 * so comments and every other entry stay as they were. Unchanged, and
 * `added: false`, when an import already means the same thing.
 */
export function withImport(
  text: string,
  entry: { ref: string; with?: Record<string, string> },
  same: (ref: string) => boolean,
) {
  const document = parseDocument(text);
  if (document.errors.length > 0)
    throw new CliError(
      `nodrail.yaml is not YAML: ${document.errors[0]!.message}`,
    );
  let imports = document.get("imports", true);
  if (imports === undefined) {
    imports = new YAMLSeq();
    document.set("imports", imports);
  }
  if (!isSeq(imports))
    throw new CliError("nodrail.yaml: imports must be a list");
  if (
    imports.items.some((item) => {
      const ref = refOf(item);
      return ref !== null && same(ref);
    })
  )
    return { text, added: false };
  imports.flow = false;
  imports.add(document.createNode(entry));
  return { text: String(document), added: true };
}
