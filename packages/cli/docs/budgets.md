# Numeric budgets (engine level 5)

A numeric budget is an **operational limit** on what agents do: calls of an operation, an amount in the calls' input, a measured result or subagent tokens. It is not your Nodrail bill. The grammar is the engine's ([`docs/contracts.md`](../../policy-engine/docs/contracts.md#numeric-budgets-enforced-engine-level-5), C03):

```yaml
- required_engine_version: 5
- rule: Publish
  tool: outbox
  operation: publish
  resource: { kind: mcp_tool, match: any }
  effect: allow
- budget: Publications per run
  id: publications
  count: { tool: outbox, operation: publish }
  limit: 3
  per: run
  otherwise: deny
```

## Labels

Each budget's label follows from what it counts and can't be configured:

| Counts                                                      | Label                                     | What it promises                                                                                                                                            |
| ----------------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `count`, `sum` of an `input.` path                          | **Enforced allowance**                    | Reserved before the call: concurrent calls can't take the last slot twice.                                                                                  |
| `sum` of a `result.` path, `tokens` with `source: measured` | **Measured usage · stops further work**   | Known only after a call: it stops the next one at the limit, it can't cap the call that crosses it. A step without a reading is unknown, and unknown holds. |
| legacy `tokens:` / `usd:`                                   | **Agent-reported usage · advisory limit** | What agents say in receipts. Still blocks at the limit.                                                                                                     |

## What apply sets up

When the effective policy has numeric budgets, `apply` registers the policy hook on the calls' outcomes as well, so reservations settle:

| Host        | Events                                                                      |
| ----------- | --------------------------------------------------------------------------- |
| Claude Code | `PostToolUse` and `PostToolUseFailure`, beside `PreToolUse`; never blocking |
| Codex       | `PostToolUse` (Codex has no failure event: a failed call stays unknown)     |
| Copilot     | `postToolUse`, whose `toolResult.resultType` says success or failure        |

A project without numeric budgets gets exactly the files and settings it got before.

- **PostToolUse** consumes the call's reservation.
- **Released** only when a mediated connection's record says the call failed or never reached the provider.
- **Unknown**: a PostToolUseFailure without such a record, or no outcome at all (a declined prompt, a crash). An unknown reservation still counts until you reconcile it.

## Scope: what a local setup can enforce

| `across`                                                               | Who counts it                           | Local setup                                                                                                                              |
| ---------------------------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `run` (default for `per: step` and `per: run`; `per: day` must say it) | this run's ledger, under the run's lock | enforced                                                                                                                                 |
| `environment`                                                          | the shared online authority             | **fails activation**: shared budgets are enforced only on a control-plane-managed connection, and the local hook would hold every call it covers |

`per: day` counts the calendar day in its `timezone` (IANA), 23 or 25 hours when the clocks change. `plan` lists each budget with its label, unit, window, scope and how it is enforced here, and refuses `across: environment`; `nodrail contracts explain <budget>` says the same for one budget.

## `nodrail budgets status`

Each numeric budget, per run in the local ledger (`.git/nodrail/runs`): used of the limit, how much is reserved and unknown, unknown measured steps, and when a day window resets. Then every reservation without a known outcome, with its key. `--run <run>` limits it to one run; `--json` for scripts; `--policy <file>` reads one rule file instead of the locked policy.

```
Budgets (operational limits, not your Nodrail bill)
  publications · Enforced allowance · per run, across run
    main: 3 of 3 calls, 1 unknown

Reservations without a known outcome (each still counts)
  claude-code:toolu_01…  publications 1 calls  unknown  run main  2026-11-21T10:00:00.000Z
```

## `nodrail budgets reconcile <key> --consumed|--released --note <why>`

Your word on one reservation, once you know what happened: `--released` gives the slot back, `--consumed` keeps it counted. The note is required and kept in the ledger. It is written under the run's lock, so the hook's next decision sees it, and it replaces the runtime's settlement. `--run <run>` names the run when the key is in more than one.

Only the person on this machine reconciles local reservations; the setup guard refuses `nodrail` to agents. On the control plane, admins and policy managers reconcile shared budgets there, audited; the two don't mirror each other.

## Limits that stay

- A host hook that times out lets the call through on the host's side; `hook-guard` exits 2 at 15 s, so a hook that never answers blocks it.
- Local records can be changed by whoever owns the machine: this is the documented trust boundary, not attestation.
