# Declared contracts in a project

> **Receipts, briefs and operation inputs are enforced by the hook.** `nodrail` accepts contracts in `nodrail.yaml`, locks them, writes them into the agent files `apply` generates, and gives them to the policy hook (engine level 4). On Claude Code and Copilot the hook reads each agent's final message against its receipt contract, and each dispatch's brief before the agent starts. On Codex nothing captures a receipt yet, so a gate that waits for one stays closed, and the hook can't read a dispatch prompt, so starting an agent that has a brief is denied. The hook checks a connection operation's `input` before any rule judges the call; the connection Nodrail runs checks it again, and the `output`, around the provider (see [connectors.md](connectors.md)). Rules and gates read the checked values with `where` on `input.` and `brief.` paths.

The grammar (dialect 1) is the engine's: see [`@nodrail/policy-engine` docs/contracts.md](https://github.com/Nodrail/nodrail-js/blob/main/packages/policy-engine/docs/contracts.md) for every type, role, limit and digest. This page is what the CLI does with it.

## What you can declare

In `nodrail.yaml`, the registry of `shapes:` and the `receipts:` that use them. On an Agent resource, `spec.receipt` (the receipt it ends with) and `spec.brief` (the shape of what it is started with):

```yaml
# nodrail.yaml
kind: nodrail.project/v1
runtime: claude-code
resources: ./resources
imports:
  - ./policies/review.yaml
shapes:
  result-base:
    properties:
      verdict: { values: [done, partial, blocked], role: verdict }
      issue: { type: string, max: 100, for: "Issue id from the brief, or none" }
      lesson: { type: string, max: 300, optional: true, for: "A useful lesson" }
  reviewer-result:
    extends: result-base
    properties:
      verdict: { values: [ship, ship-with-debt, fix-first], role: verdict }
      findings:
        role: findings
        report: true
        properties:
          blocker: { type: integer, min: 0 }
          major: { type: integer, min: 0 }
      anchor:
        {
          values: [fresh, stale],
          for: "Your assessment; runtime verifies freshness independently",
        }
receipts:
  reviewer: { shape: reviewer-result }
```

```yaml
# resources/team.yaml
apiVersion: apf.nodrail.com/v1alpha1
kind: Agent
metadata: { name: reviewer }
spec: { instructions: ./reviewer.md, receipt: reviewer }
```

An Agent without `spec.receipt` gets the receipt of its own name, if there is one; `plan` shows it as `(by its name)`.

`spec.brief` is a shape name (a final `nodrail-brief` block) or the object form, for flat `key: value` lines in the prompt with aliases from a line's key to a property:

```yaml
spec:
  brief:
    {
      shape: work-brief,
      format: header,
      header: { aliases: { ticket: issue } },
    }
```

The engine's compiler checks all of it, and the CLI refuses the project on any issue: an unknown key, a missing shape, a receipt without a verdict, a gate waiting for a verdict the receipt can't give (`pass isn't a verdict this receipt can give (verdict-value)`). `evidence:` is read too, with engine level 5: see [evidence.md](evidence.md). Every other contract key (`approvals:`, `views:`…) is still refused, with the key named: this release reads none of them.

A connection's operation may name the shape of its arguments and of its result:

```yaml
connections:
  stripe:
    command: npx
    args: ["-y", "@stripe/mcp@1.2.3"]
    operations:
      refund: { input: refund-args, output: refund-result }
```

The bindings are `input:stripe.refund` and `output:stripe.refund`. Only `input` and `output` are read here; any other key in an operation is the setup schema's, which stays strict.

A project that declares no contracts is resolved, locked and set up exactly as before, byte for byte.

## What the hook reads

The hook reads only rule files, so `plan`, `apply` and `policy export --frozen` put the contracts at the top of the effective policy (`.nodrail/effective.apf.yaml`) as one `contracts` entry, in a file that asks for engine level 4:

```yaml
# ── nodrail.yaml (contracts)
# The contracts the hook enforces, from nodrail.yaml: the receipt each
# agent ends with, the brief it is started with, and each connection
# operation's input. Rules and gates read them with where.
- required_engine_version: 4
- contracts:
    shapes:
      result-base: …
      reviewer-result: …
      work-brief: …
      refund-args: …
    receipts:
      reviewer:
        shape: reviewer-result
    agents:
      publisher:
        brief: work-brief
      reviewer:
        receipt: reviewer
    connections:
      stripe:
        operations:
          refund:
            input: refund-args
```

Only what the hook enforces goes in: the receipts an Agent ends with, each Agent's brief as declared (shape name or object form), each operation's `input`, and the shapes they need (`extends` parents included). An `output` is read where the call is mediated, never by the hook. The compiled document is then `version: 3`: each receipt, brief and input contract pinned by the digest the lock records. A project that declares none of them gets the effective policy it always got.

A rule or gate reads a checked value with `where` on `input.` (the call's arguments) or `brief.` (for a rule on one agent: `resource: { kind: agent, match: exact, value: <agent> }`), in a rule file that asks for `required_engine_version: 4` itself:

```yaml
- required_engine_version: 4
- rule: Small refunds in staging
  tool: stripe
  operation: refund
  resource: { kind: mcp_tool, match: any }
  where: { input.amount: { max: 5000 }, input.environment: staging }
  effect: allow
```

An invalid, missing or (on Codex) unobservable brief denies the dispatch, and invalid arguments deny the call, before any rule: the agent never starts and the provider is never called. Reasons name paths and codes, never a value.

**In Nodrail Cloud, `where` reads only reported fields.** Cloud evaluates a condition on a brief or an input with the fields the projection reports; one on a field that isn't reported is never met there (fail-closed). The local hook reads the whole value. `plan` lists each such condition, and `contracts explain` marks it. Report a field (`report: true`) only if it may leave the machine.

With receipts, gates or budgets, `apply` runs the same hook when a subagent starts and stops: `SubagentStart` and `SubagentStop` in `.claude/settings.json`, `subagentStart` and `subagentStop` in `.github/hooks/nodrail.json`. The step finishes with the receipt that ends the agent's final message, read against its contract: only a **valid** one counts for a gate, and a gate's `where:` is checked on its values. An invalid or missing receipt leaves the gate unmet. Codex has no such hooks from nodrail yet: a gate that waits for a receipt stays closed there.

Gate requirements may use contract fields (`where`) in a rule file that asks for `required_engine_version: 4` itself. Declare contracts once: a rule file with its own `contracts` entry, in a project whose `nodrail.yaml` declares contracts, is refused.

## The receipt section in agent files

`nodrail apply` writes one marked section at the end of each generated agent file whose agent has a receipt (`.claude/agents/<name>.md`, `.codex/agents/<name>.toml` or the entry agent's `developer_instructions` in `.codex/config.toml`, `.github/agents/<name>.agent.md`). Your own instructions file is never edited. The section says what to end with, each property with its `for:` text and allowed values, and an example made from the contract. The example is validated against the contract before it is written, then read back as the hook reads a final message: inherited properties included, optional ones shown, dates quoted.

````markdown
<!-- nodrail:receipt begin: receipt reviewer, shape reviewer-result, contract sha256:1b57b28e954d. Written by nodrail from nodrail.yaml; change it there. -->

## Your receipt

End your final message with a receipt: a `nodrail-receipt` block that is the last thing in the message, with nothing after its closing fence. Only that last block is read. Nothing is taken from your prose, and a receipt that breaks these rules counts as no receipt.

The block is YAML. Start it with `agent: reviewer`, then give exactly these properties, and no others:

- `verdict` (required; your verdict): one of `ship`, `ship-with-debt`, `fix-first`.
- `issue` (required): text, at most 100 characters. Issue id from the brief, or none
- `lesson` (optional): text, at most 300 characters. A useful lesson
- `findings` (required; your findings): an object with:
  - `blocker` (required): a whole number, at least 0.
  - `major` (required): a whole number, at least 0.
- `anchor` (required): one of `fresh`, `stale`. Your assessment; runtime verifies freshness independently

For example:

```nodrail-receipt
agent: reviewer
verdict: ship
issue: example
lesson: example
findings: { blocker: 0, major: 0 }
anchor: fresh
```

<!-- nodrail:receipt end -->
````

A `format: header` receipt (the flat legacy bridge) gets the header form instead: the title line (`RECEIPT reviewer`), one `key: value` line per property under its alias, a list as items separated by commas, and a note when a mode prefix is allowed. The example writes the verdict word in capitals (`RECEIPT qa` / `result: PASS`), as legacy receipts do, and the section says the verdict may be in any case: the header reader compares it in lowercase. Every other value is written exactly as listed. A findings object of counts is one line, a count before each category: `findings: 0 blocker / 1 major` (`none` when every count is 0).

## The brief section

An Agent with `spec.brief` is started with a brief. The agents that may start it (the Team's `handoffs`, `from` → that agent) get one marked section in their generated files, before their own receipt section:

````markdown
<!-- nodrail:brief begin: briefs for publisher. Written by nodrail from nodrail.yaml; change it there. -->

## Briefs for the agents you start

When you start this agent, give it its brief in the prompt, as below. The policy hook reads the brief before the agent starts: a missing or invalid brief, or one for another agent, stops the agent from starting. Only the brief is read; nothing is taken from your prose.

### publisher

Brief publish-brief, contract sha256:…. What the publisher needs to start

End the prompt with a `nodrail-brief` block: YAML, the last thing in the prompt, with nothing after its closing fence. Start the block with `agent: publisher`, then give exactly these properties, and no others:

- `issue` (required): text, at most 40 characters. The issue to publish
- `channel` (required): one of `blog`, `changelog`.

For example:

```nodrail-brief
agent: publisher
issue: example
channel: blog
```

<!-- nodrail:brief end -->
````

A `format: header` brief gets `key: value` lines instead (`agent: publisher`, then one line per property under its alias), anywhere in the prompt. The example is read back with the engine's brief reader, the one the hook checks each dispatch with, before it is written.

## Commands

All three read `nodrail.yaml` and its resources in this folder, and the file you give. They write nothing, run no tool and need no account. `--json` gives the same answer as JSON.

### `nodrail contracts render <agent | brief:agent>`

Prints the sections nodrail writes into an agent's file (the briefs of the agents it starts, then its receipt), to paste into an agent file nodrail doesn't manage. `<agent>` is an Agent resource, or the name of a receipt no Agent uses yet. `brief:<agent>` prints the brief section for that one agent, for whatever starts it.

### `nodrail contracts validate <target> <file>`

Checks a sample against a contract. `<target>` is a binding (`receipt:reviewer`, `brief:triage`, `input:stripe.refund`, `output:stripe.refund`) or a shape (`shape:reviewer-result`, or its name). The file is the value as YAML or JSON, or, for a receipt, a message read with the engine's own receipt reader, as the hook reads one: the last `nodrail-receipt` block, ending the message, at most 8 KiB; or, for a `format: header` receipt, its `RECEIPT <agent>` block (bold, bullets, a fence, a mode prefix and lines the contract doesn't map are all read as the hook reads them, and a list is its items separated by commas). A receipt's `agent` is its identity and must name an agent that ends with that receipt. A message with no receipt ending it is `missing`: it counts as no receipt. For a brief, the file is a dispatch prompt read with the engine's brief reader, as the hook reads one: its last `nodrail-brief` block, ending it (at most 16 KiB; `agent:`, when given, must name the agent being started), or the brief's properties as YAML; for a `format: header` brief, its `key: value` lines. For an `input:` binding, the file is the call's arguments, checked strictly as the hook checks them (at most 16 KiB). A valid receipt's findings are shown as a header line writes them: `1 finding (0 blocker / 1 major)`; `--json` gives them as `findingsLine`.

```text
$ nodrail contracts validate receipt:reviewer samples/message.md
valid: samples/message.md against receipt:reviewer (shape reviewer-result, contract sha256:1b57b28e954d)
Read as the hook reads it: verdict ship, 1 finding (0 blocker / 1 major)
Reported (may leave this machine): {"verdict":"ship","findings":{"blocker":0,"major":1}}
Withheld: issue, lesson, anchor

$ nodrail contracts validate receipt:reviewer samples/bad.yaml
invalid: samples/bad.yaml against receipt:reviewer (shape reviewer-result, contract sha256:1b57b28e954d)
  verdict: enum (expected one of ship, ship-with-debt, fix-first)
  findings.blocker: type (expected integer)
  anchor: required
nodrail: samples/bad.yaml doesn't match receipt:reviewer.

$ nodrail contracts validate receipt:developer samples/legacy.md
valid: samples/legacy.md against receipt:developer (shape developer-result, contract sha256:7c4a24f88792)
Read as the hook reads it: verdict done, 2 findings (tests, docs)
Reported (may leave this machine): {"result":"done"}
Withheld: categories, branch
```

An issue names a path and a reason, never the rejected value. Exit code 1 when the sample doesn't match.

### `nodrail contracts explain <binding | gate>`

What a binding asks for and who reads it, or what a gate waits for and what satisfies each requirement. A gate is named by its `gate:` text or its `id`.

```text
$ nodrail contracts explain reviewed
Gate "Merge after review" (id reviewed)
  Holds github pr.merge until every requirement is met; until then: deny.
  Requirements:
    1. reviewer gives verdict ship or ship-with-debt
       Read from receipt:reviewer: only a receipt valid against its contract counts, and its verdict must be ship or ship-with-debt. Authority: agent-reported.
  A gate only holds an action back: meeting it never allows what no rule allows.
```

For a binding it shows the shape, the contract and projection digests, each property with whether it is reported (an object of findings counts as `counts of blocker, major`, written `0 blocker / 1 major` on a header line), what is withheld, and the gates and rules that read it; a `where` on a field Cloud can't read is marked `not reported, so never met in Nodrail Cloud`.

## The lock and the review

`nodrail policy lock` records two sections, only when the project declares contracts:

- `contracts:` the engine's digests: `dialect`, the workspace `digest`, and each shape's `contract` and `projection` digest. It is the engine's lock format (C07).
- `contractsBaseline:` each binding with its digest, each Agent's receipt and brief, and every resolved shape: what the next change is compared with.

The workspace digest covers the contracts' digest too. `nodrail policy export --frozen` and `nodrail plan` refuse contracts that differ from the lock.

When the contracts change, `nodrail policy lock` (compared with the last committed lock) and `nodrail plan` (compared with the lock on disk) classify each change:

```text
Contracts, compared with the last committed nodrail.lock.yaml:
  breaking    receipt:reviewer  anchor: no longer accepts stale
  breaking    receipt:reviewer  owner: new and required
  disclosure  receipt:reviewer  lesson: now reported, so it leaves this machine
  compatible  receipt:reviewer  anchor: its instructions (for) changed
```

- **breaking**: a value that was valid may now be refused: a property removed or newly required, a type or unit changed, an enum value gone, bounds narrowed, a receipt removed or an agent's receipt or brief changed.
- **disclosure**: a field newly reported, so it now leaves the machine. Review these as you would a privacy change.
- **unknown**: a change the CLI can't classify, such as a role or a format change.
- **compatible**: everything else: new optional properties, values added, bounds widened, instructions changed, a field no longer reported.

## Limits

- Receipts are enforced on Claude Code and Copilot. On Codex nothing captures one yet: a gate that waits for a receipt stays closed.
- Briefs are checked by the hook on Claude Code and Copilot. Codex hands the hook the dispatch prompt encrypted, so starting an agent that has a brief is denied there.
- The hook checks a connection `input` before the rules; the `output` is checked only by the connection Nodrail runs.
- In Nodrail Cloud a `where` on an unreported brief or input field is never met.
- Evidence is declared once, in nodrail.yaml, like shapes and receipts; a rule file's own `contracts` entry that declares evidence is refused there. Gates read it at engine level 5 ([evidence.md](evidence.md)).
- Every other contract key (`approvals:`, `views:`…) is refused: this engine can't observe them yet.
