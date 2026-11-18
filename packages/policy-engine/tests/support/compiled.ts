import type { PolicyDocument } from "../../src/policies";
import { compilePolicies } from "../../src/yaml";

/** One rules file's compiled document; a file that doesn't compile fails the test. */
export function compiled(text: string): PolicyDocument {
  const result = compilePolicies([{ name: "rules.yaml", text }]);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.document;
}
