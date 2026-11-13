# Library

This page shows how to use the engine from TypeScript: compile rule files, decide a call, and describe tool calls the way the hooks do.

```ts
import { simulate } from "@nodrail/policy-engine";
import { compilePolicies } from "@nodrail/policy-engine/yaml";

const compiled = compilePolicies([{ name: "rules.yaml", text }]);
if (!compiled.ok) throw new Error(JSON.stringify(compiled.issues));

const { outcome, matchedRuleId, explanation } = simulate({
  document: compiled.document,
  descriptor: {
    agentId: "support-agent",
    installationId: "support-dev",
    toolKey: "github",
    operationKey: "issues.update",
    resourceKind: "repository",
    resourceId: "acme/infra",
    params: {},
  },
  now: new Date(),
});
```

`outcome` is `allow`, `deny`, `require_approval` or `none`. Treat everything except `allow` as blocked unless you have a way to get a person's answer.

Read `outcome` for the decision and `matchedRuleId` for the rule that matched. When no rule matches, the outcome is `none` and `matchedRuleId` is `null`.

**Level 3 preview.** Run-aware builds can also return gate results, budget results and warnings. See [Run history in the library (preview)](runs.md#library).

| Import                             | Contains                                            | Runs on                |
| ---------------------------------- | --------------------------------------------------- | ---------------------- |
| `@nodrail/policy-engine`           | Evaluator, schemas, simulator, command judging, run history types and schemas (level 3 preview) | Any JavaScript runtime |
| `@nodrail/policy-engine/yaml`      | `compilePolicies`, `renderPolicies`, `starterPacks` | Any JavaScript runtime |
| `@nodrail/policy-engine/simulator` | `simulate` on its own                               | Any JavaScript runtime |
| `@nodrail/policy-engine/actions`   | `describeToolCall`, `describeArguments`, `redact`   | Node                   |
| `@nodrail/policy-engine/protocol`  | Canonical digests for the Nodrail runtime protocol  | Node                   |
| `@nodrail/policy-engine/receipts`  | `parseReceipt`                                      | Node                   |
| `@nodrail/policy-engine/hook-runs` | Level 3 preview. `runKey`, `receiptBlock`, `agentName`, with no zod or YAML | Node            |

## Connect a custom harness

A harness can read the same APF file as another integration when both map an operation to equivalent facts. In this example the harness exposes two named operations. Each maps to a fixed command. Its tool records a call in memory so you can see whether the integration actually invoked it.

Save this policy as `rules.yaml` in an empty directory.

```yaml
- required_engine_version: 2
- rule: Inspect the working tree
  command: git status
  effect: allow
- rule: Protect untracked files
  command: git clean -fd
  effect: deny
```

Install `@nodrail/policy-engine` with `pnpm add @nodrail/policy-engine`. Save the following as `demo.mjs` alongside `rules.yaml` and run `node demo.mjs` with Node.js 22 or later.

```js
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
```

The decisions are `allow` and `deny`. Only `inspect` appears in the invocation list. This example exercises a custom wrapper using an in-memory tool. In a real adapter, derive the descriptor from the exact call you will execute and preserve the arguments and resource through invocation. For arbitrary shell input use the documented action-mapping helpers, which also handle compound commands. Hold `require_approval` until an authorized review completes, and block `none`, invalid input and evaluation errors. Run-dependent gates and budgets also need the appropriate history.

[Compare integrations](https://nodrail.com/integrations) · [Evaluator test cases](https://github.com/Nodrail/nodrail-js/blob/main/packages/policy-engine/tests/fixtures/conformance-v1.json)

## Rule files

`compilePolicies` takes files in load order and returns `{ ok: true, document, rules, warnings }` or `{ ok: false, issues, warnings }`. Each issue has `file`, `line`, `column` and `message`. The line and column (from 1) are where the problem is written: an unknown key at that key, a bad value at that value, a duplicate at its name or `id`, and anything missing at the entry it belongs to, so an editor can underline it. `renderPolicies` turns a document back into YAML.

## Describing calls

```ts
import { describeToolCall } from "@nodrail/policy-engine/actions";

const action = describeToolCall("Bash", { command: "git status" });
// { tool: "shell", operation: "command.run", resource: { kind: "command", id: "git status" }, ... }
```

It returns `null` for a call it can't describe, which you should treat as blocked.

## Behavior

- The simulator needs an explicit clock, and rejects an invalid clock, malformed input and parameters that aren't plain JSON.
- Evaluating never invokes a tool or changes anything.
- Agent and installation names are whatever the caller declares. They are not authenticated.

## Versioning

The package follows semantic versioning. The rule file format and the compiled policy document are versioned separately: rule files ask for an engine level with `required_engine_version` (level 3 is in preview), and documents are `version: 1`, or `version: 2` when they have gates or budgets. See [Run-history versions (preview)](runs.md#versions). [`tests/fixtures/conformance-v1.json`](https://github.com/Nodrail/nodrail-js/blob/main/packages/policy-engine/tests/fixtures/conformance-v1.json) holds test vectors for anyone building a compatible evaluator.
