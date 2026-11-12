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

The result also has `reason` (`explicit_rule`, `gate`, `budget` or `no_matching_rule`), `gates`, `budgets` and `warnings`. For rules with gates or budgets, pass the run's history as `run`; without it every gate holds. See [Runs, gates and budgets](runs.md#library).

| Import                             | Contains                                            | Runs on                |
| ---------------------------------- | --------------------------------------------------- | ---------------------- |
| `@nodrail/policy-engine`           | Evaluator, schemas, simulator, command judging, run history types and schemas | Any JavaScript runtime |
| `@nodrail/policy-engine/yaml`      | `compilePolicies`, `renderPolicies`, `starterPacks` | Any JavaScript runtime |
| `@nodrail/policy-engine/simulator` | `simulate` on its own                               | Any JavaScript runtime |
| `@nodrail/policy-engine/actions`   | `describeToolCall`, `describeArguments`, `redact`   | Node                   |
| `@nodrail/policy-engine/protocol`  | Canonical digests for the Nodrail runtime protocol  | Node                   |
| `@nodrail/policy-engine/receipts`  | `parseReceipt`                                      | Node                   |
| `@nodrail/policy-engine/hook-runs` | `runKey`, `receiptBlock`, `agentName`, with no zod or YAML | Node            |

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

The package follows semantic versioning. The rule file format and the compiled policy document are versioned separately: rule files ask for an engine level with `required_engine_version` (now 3), and documents are `version: 1`, or `version: 2` when they have gates or budgets. See [Versions](runs.md#versions). [`tests/fixtures/conformance-v1.json`](https://github.com/Nodrail/nodrail-js/blob/main/packages/policy-engine/tests/fixtures/conformance-v1.json) holds test vectors for anyone building a compatible evaluator.
