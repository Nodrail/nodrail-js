import { isDeepStrictEqual } from "node:util";
import {
  compilePolicies,
  renderPolicies,
  type PolicySource,
} from "@nodrail/policy-engine/yaml";
import { CliError } from "../io.ts";

const HEADER = `# The effective policy of this project, exported by nodrail from
# nodrail.yaml and nodrail.lock.yaml. Regenerate it; don't edit it.
`;

/** Each file's text in effect order, headed by where it came from. */
function joined(sources: PolicySource[]) {
  const parts = sources.map(
    (source) => `# ── ${source.name}\n${source.text.replace(/\n*$/, "\n")}`,
  );
  return `${HEADER}\n${parts.join("\n")}`;
}

const compiled = (name: string, text: string) =>
  compilePolicies([{ name, text }]);

/**
 * The project's policy as one ordinary APF file, and its compiled document.
 * The files are joined as written, so comments stay; the result must compile
 * to exactly what the files compile to separately. If joining ever changed
 * the meaning, the document is rendered back instead, and checked the same.
 */
export function effectivePolicy(sources: PolicySource[]) {
  const separate = compilePolicies(sources);
  if (!separate.ok)
    throw new CliError(
      `The policy doesn't compile:\n${separate.issues
        .map((issue) => `  ${issue.file}:${issue.line}: ${issue.message}`)
        .join("\n")}`,
    );
  // Rendered only when joining changed the meaning: the engine can't
  // render every document back (a version 4 one, yet), and joining is how
  // most policies are written anyway.
  for (const text of [
    () => joined(sources),
    () => HEADER + renderPolicies(separate.document),
  ]) {
    let written: string;
    try {
      written = text();
    } catch {
      continue;
    }
    const one = compiled("effective.apf.yaml", written);
    if (one.ok && isDeepStrictEqual(one.document, separate.document))
      return { text: written, document: separate.document };
  }
  throw new CliError(
    "The policy can't be written as one file that means the same",
  );
}
