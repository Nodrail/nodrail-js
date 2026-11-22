# Mediated connections (preview)

> **Preview.** A connection whose operations declare `input` or `output` in `nodrail.yaml` is started mediated: `apply` writes its compiled contracts into `.nodrail/connections.json`, and `nodrail connection run`, which every host starts each connection with, checks each call on its way to the provider and back. The policy hook also checks a declared `input` on the host's tool call, before any rule judges it, and rules read the checked arguments with `where` on `input.` (see [contracts.md](./contracts.md#what-the-hook-reads)); a result is checked only here, in the connection.

How `nodrail connection run` serves a mediated connection: a Nodrail connector (`command: nodrail`, `args: [connector, …]`) runs in the same process, its tools wrapped; any other command is started as an MCP server on stdio and proxied. Either way the provider gets exactly the environment the connection declares (`env:`, its secrets resolved) and the few variables every program needs, never the host's whole environment, and runs in the project folder. Records go to `.nodrail/records/<connection>/calls.jsonl`: the project's data, kept from agents like the rest of `.nodrail`, never locked, and left by `destroy`.

A connection's operation can declare the shape of its arguments and of its result (see [contracts.md](./contracts.md) and the engine's `docs/contracts.md`, S03 and S04):

```yaml
connections:
  stripe:
    command: npx
    args: ["-y", "@stripe/mcp"]
    operations:
      refund: { input: refund-args, output: refund-result }
```

## Why a result needs Nodrail in the path

A host hook doesn't see a tool's whole result. Claude Code hands a hook only `structuredContent` when a result has it, and both Claude Code and Copilot replace a large result (from about 40 000 characters on Claude Code, 20 000 on Copilot) with a "saved to <path>" note before any hook runs. A hook can only report on what it received, and it can't hold a result back. So a result contract is checked only on a **mediated connection**: Nodrail runs the connection, calls the provider and checks the answer before the agent gets it.

Two kinds of connection can be mediated:

- Nodrail's own connectors (`files-search`, `http-search`, `outbox`).
- Any provider that is an MCP server on stdio: Nodrail starts it, lists its tools and calls them for the agent.

## One call, step by step

1. **Input.** When the operation declares `input`, the arguments are checked against it with the engine's own input check (the same one the policy hook runs): strict, unknown arguments refused, 16 KiB at most. Arguments that don't conform are refused with the paths and reasons (`amount: below, currency: enum`) and **the provider is not called**.
2. **The provider is called once.** Nodrail never sends a call again, whatever comes back.
3. **Execution.** A provider error is passed on as the provider wrote it, recorded as `failed`. A provider that stops answering (it exits, or doesn't answer within two minutes) leaves the outcome `unknown`: the effect may have happened. A call to a provider that had already exited is never sent and is recorded as `not-called`.
4. **Result.** When the operation declares `output`, the result is checked: its `structuredContent` when it has one, otherwise its single text block read as JSON. 64 KiB at most, measured before it is parsed.
   - **valid**: the agent gets the checked value, and only it.
   - **invalid**: withheld. The agent gets an error saying the operation ran, which paths don't conform, and not to call it again to retry.
   - **unsupported**: a result that isn't one structured value (prose, an image, several blocks) can't be checked, so it isn't called valid: it is withheld the same way.

An operation that declares neither runs as before and is recorded with no checks: Nodrail makes no claim about it.

Errors and records name a path and a reason, never a value. Arguments and result fields classified `secret` or `pii` never appear in them.

## The record of a call

Each call produces one record, kept before the agent gets its answer (as JSON Lines in `<folder>/calls.jsonl` when a records folder is given):

```json
{
  "type": "connection.call",
  "event": "6f0c…",
  "connection": "stripe",
  "operation": "refund",
  "occurred_at": "2026-11-21T10:00:00.000Z",
  "producer": { "class": "runtime-observed", "id": "connector:stripe" },
  "input": {
    "surface": "S03",
    "name": "input:stripe.refund",
    "shape": "refund-args",
    "contract": "sha256:…",
    "projection": "sha256:…",
    "state": "valid",
    "at": "local",
    "issues": [],
    "reason": null,
    "values": { "amount": 4200, "currency": "usd" }
  },
  "execution": "succeeded",
  "result": {
    "surface": "S04",
    "name": "output:stripe.refund",
    "state": "invalid",
    "issues": [{ "path": "status", "code": "enum" }],
    "reason": null,
    "values": null,
    "…": "…"
  },
  "delivered": false
}
```

- `execution` is what the provider did: `succeeded`, `failed`, `not-called` or `unknown`. It is never changed by the result's state: an invalid result of a refund that happened is still a refund that happened.
- `input` and `result` are `null` when nothing is declared, or, for `result`, when the provider didn't succeed.
- `state` is `valid`, `invalid` or `unsupported`; `reason` says why a value couldn't be read (`not-json`, `content-form`).
- `values` is the reporting projection of a valid value: only fields with `report: true`, never a classified one.
- `delivered` says whether the agent received the provider's answer.

## In the run ledger

A connector also appends each record to the local run ledger, as a `connection.call` event wrapping the record, written with the engine's ledger writer while it holds the run's lock, so the hook deciding the next call in that run reads it. The event is placed under the main agent with no step: a connector isn't told which step called it. The run is the one `NODRAIL_RUN` names, else the branch's; on the default branch with no `NODRAIL_RUN` a connector has no run to join (it isn't told the host's session), and only `calls.jsonl` keeps the call. A ledger that can't take the event (busy, unwritable) is reported on stderr; the agent still gets its answer and `calls.jsonl` still gets the record.

Besides the record, each call's sinks get the arguments' digest (`input_sha256`, the canonical-JSON SHA-256 the policy hook gives the same call) and the result amounts budgets sum.

## Budgets

A connector settles what a budget reserved for a call by its execution, under the same run lock, right after it records the call:

| Execution                                          | Settlement                                          |
| -------------------------------------------------- | --------------------------------------------------- |
| `succeeded`                                        | consumed (whatever the result's state)              |
| `failed`                                           | released                                            |
| `not-called`, including input the contract refused | released                                            |
| `unknown`                                          | unknown: still counted until a person reconciles it |

A budget that sums a `result.` path reads it only from a valid result, and only where the output contract declares an unclassified `integer`. A missing, negative or unsafe value, or a withheld result, is a gap, never 0, so the budget holds. [budgets.md](budgets.md) says how the hook reserves and how `nodrail budgets` shows and reconciles what is left unknown.
