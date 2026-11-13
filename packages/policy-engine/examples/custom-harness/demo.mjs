import { readFileSync } from "node:fs";
import { compilePolicies } from "@nodrail/policy-engine/yaml";
import { simulate } from "@nodrail/policy-engine";

const text = readFileSync(new URL("./rules.yaml", import.meta.url), "utf8");
const compiled = compilePolicies([{ name: "rules.yaml", text }]);
if (!compiled.ok) throw new Error(JSON.stringify(compiled.issues));

// These two harness operations have fixed mappings to simple commands.
// The sample tool records an invocation in memory.
const invoked = [];
const commands = new Map([
  ["inspect", "git status"],
  ["clean", "git clean -fd"],
]);
function invoke(operation) {
  const command = commands.get(operation);
  if (!command) throw new Error("Unknown operation");
  const { outcome } = simulate({
    document: compiled.document,
    now: new Date(),
    descriptor: {
      agentId: "example-agent",
      installationId: "local-example",
      toolKey: "shell",
      operationKey: "command.run",
      resourceKind: "command",
      resourceId: command,
      params: {},
    },
  });
  if (outcome === "allow") invoked.push(operation);
  return outcome;
}
console.log(invoke("inspect"), invoke("clean"), invoked);
