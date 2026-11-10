# Library

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

| Import                             | Contains                                            | Runs on                |
| ---------------------------------- | --------------------------------------------------- | ---------------------- |
| `@nodrail/policy-engine`           | Evaluator, schemas, simulator, command judging      | Any JavaScript runtime |
| `@nodrail/policy-engine/yaml`      | `compilePolicies`, `renderPolicies`, `starterPacks` | Any JavaScript runtime |
| `@nodrail/policy-engine/simulator` | `simulate` on its own                               | Any JavaScript runtime |
| `@nodrail/policy-engine/actions`   | `describeToolCall`, `describeArguments`, `redact`   | Node                   |
| `@nodrail/policy-engine/protocol`  | Canonical digests for the Nodrail runtime protocol  | Node                   |

## Rule files

`compilePolicies` takes files in load order and returns `{ ok: true, document, rules, warnings }` or `{ ok: false, issues, warnings }`. Each issue has `file`, `line`, `column` and `message`. `renderPolicies` turns a document back into YAML.

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

The package follows semantic versioning. The rule file format and policy document are versioned separately, starting at 1. [`tests/fixtures/conformance-v1.json`](https://github.com/Nodrail/nodrail-js/blob/main/packages/policy-engine/tests/fixtures/conformance-v1.json) holds test vectors for anyone building a compatible evaluator.
