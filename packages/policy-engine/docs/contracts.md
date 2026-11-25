# Declared contracts (dialect 1)

> **Partly enforced.** This page freezes the grammar, attachment locations, privacy and authority model of declared contracts, dialect 1. The engine compiles and checks all of it (`@nodrail/policy-engine/contracts`). Receipts (S01) and gates on them (C01), briefs (S02), connection operation inputs (S03) and typed `where` on rules and gates over them (C02) are enforced by the local hook at engine level 4: see [How a receipt is read](#how-a-receipt-is-read-enforced-engine-level-4) and [Briefs and tool inputs](#briefs-and-tool-inputs-enforced-engine-level-4). Evidence requirements on gates (S05 on C01) and numeric budgets (C03) are enforced at engine level 5: see [Evidence requirements](#evidence-requirements-enforced-engine-level-5) and [Numeric budgets](#numeric-budgets-enforced-engine-level-5). Every other surface is not enforced yet, and engines refuse it (see [Older engines](#older-engines-refuse-never-ignore)). Enforcement arrives surface by surface; a surface counts as supported only when its runtime capture is proven, never because its YAML parses.

A **shape** is the internal primitive: bounded, typed properties and what they mean. A **contract** is a shape attached somewhere (a receipt, a brief, a tool's input…) with a version, a digest, a reporting projection and failure behavior. One registry, one type system, one validator, for every attachment.

## Contents

- [Shapes](#shapes)
- [Where contracts attach (S01–S09)](#where-contracts-attach-s01s09)
- [Conditions: where](#conditions-where)
- [Consumers (C01–C10)](#consumers-c01c10)
- [Older engines refuse, never ignore](#older-engines-refuse-never-ignore)
- [Digests and the lock](#digests-and-the-lock)
- [Authority, provenance and privacy](#authority-provenance-and-privacy)
- [Validation and issues](#validation-and-issues)
- [Limits](#limits)

The examples are contract fixtures: `nodrail.yaml` holds what goes in that file, `resources` the resource documents, `policy` one rule file's items, `modules`, `lock` and `cases` the rest. Each example on this page is compiled by the engine's tests, as are the fixtures for every coverage ID in `tests/fixtures/contracts/<ID>/`.

## Shapes

`shapes:` in `nodrail.yaml` is the one registry. Each shape has `properties`, an optional `for` and an optional `extends`. Metadata never collides with a property, because properties sit under `properties`.

```yaml contracts
nodrail.yaml:
  shapes:
    result-base:
      properties:
        verdict: { values: [done, partial, blocked], role: verdict }
        issue:
          { type: string, max: 100, for: "Issue id from the brief, or none" }
        lesson:
          { type: string, max: 300, optional: true, for: "A useful lesson" }
    reviewer-result:
      extends: result-base
      properties:
        verdict:
          {
            values: [ship, ship-with-debt, fix-first, unassessable],
            role: verdict,
          }
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
    reviewer: { shape: reviewer-result, format: fenced }
resources:
  - apiVersion: nodrail.com/v1alpha1
    kind: Agent
    metadata: { name: reviewer }
    spec: { instructions: ./agents/reviewer.md, receipt: reviewer }
cases:
  - name: ship with one major finding
    target: receipt:reviewer
    value:
      {
        verdict: ship,
        issue: ENG-123,
        findings: { blocker: 0, major: 1 },
        anchor: fresh,
      }
    expect: valid
    projection: { verdict: ship, findings: { blocker: 0, major: 1 } }
```

### Types

A property's type comes from `type`, or from the key that implies it: `values` is an enum, `properties` an object, `of` a list. Give one of them; `type` next to `values` is an error.

| Type                  | Keys                 | Meaning                                                                                                  |
| --------------------- | -------------------- | -------------------------------------------------------------------------------------------------------- |
| `string`              | `min`, `max`         | Length in Unicode code points. `max` defaults to 1,000, the ceiling.                                     |
| enum (`values`)       | —                    | 1–50 distinct values of `a-z`, `0-9`, `_`, `.`, `-` (up to 64). Exact match: no lowercasing.             |
| `integer`             | `min`, `max`, `unit` | A safe integer.                                                                                          |
| `number`              | `min`, `max`, `unit` | A finite number: `.inf` and `.nan` fail.                                                                 |
| `boolean`             | —                    | `true` or `false`, never `"false"`.                                                                      |
| `date`                | `min`, `max`         | A quoted `YYYY-MM-DD` that exists in the Gregorian calendar. A timestamp or a parsed date object fails.  |
| `list`                | `of`, `min`, `max`   | Items of one type; `max` defaults to 50, the ceiling. A list of lists is refused: use a list of objects. |
| object (`properties`) | `properties`         | Named properties, each declared the same way.                                                            |

Every property may also set `optional: true` (properties are required otherwise), `for:` (instruction text, at most 500 characters), `role:`, `report:` and `classification:`. A list's `of` item can't set `optional`, `role`, `report` or `classification`: set them on the list. `unit` (`usd_cents`, `ms`, `tokens`…) goes on numbers only; equal units are the only compatible ones.

Any key not listed here is an error. There is no pattern, regex, expression or untyped escape hatch.

`for` is instruction text. It changes neither validation nor authority, is part of the contract digest (it is reviewed content, like agent instructions), and is never uploaded unless its property is reported.

### Inheritance

`extends` is one level deep: the parent can't itself extend, so there are no chains and no cycles. The child's properties are merged by name over the parent's; a child property replaces the parent's whole definition, never a piece of it. A child can't remove a parent property. The resolved shape is what is checked, digested and validated, so a breaking change made through a parent is still breaking.

### Limits and how they are counted

- **Depth**: a top-level property is level 1; each object and each list adds a level. A list of strings at level 3 has its items at level 4; a list of objects at level 2 has its item properties at level 4. At most 4.
- **Size**: at most 64 named properties in the resolved shape, nested ones and list-item ones included, each counted once however many items a value has.
- At most 128 shapes per workspace, imports included; 50 enum values; 20 conditions per `where`.

YAML aliases are expanded before counting, so neither aliases nor inheritance can multiply a shape past these limits.

### Roles

Roles say what a property means to Nodrail. Each role goes on a top-level property, at most once per shape, never with a classification.

| Role       | Form                                                                                                                                                                                        | Accepted on                                                        |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `verdict`  | A required enum of verdict words (up to 32 characters of `a-z`, `0-9`, `_`, `-`).                                                                                                           | Receipts only, **exactly once**.                                   |
| `findings` | A list of enum categories (each counted once; repeats are invalid), or an object of required integer counts with `min: 0`. The count is the number of categories, or the sum of the counts. | Receipts and evidence.                                             |
| `usage`    | An object of `tokens` (integer) and/or `usd` (number), each with `min: 0`. Always agent-reported: it never becomes a trusted measurement.                                                   | Receipts.                                                          |
| `kind`     | A required enum.                                                                                                                                                                            | Memory records (exactly once) and file frontmatter (at most once). |

A role on an attachment that doesn't accept it is an error, never ignored.

## Where contracts attach (S01–S09)

Every attachment names a shape from the registry. The binding names in the second column are what plans, locks and test cases use.

| ID  | Declared at                                                                                                                                                                                             | Binding             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| S01 | `receipts.<name>: { shape, format }` in `nodrail.yaml`; Agent `spec.receipt: <name>`. An Agent without `spec.receipt` gets the receipt of its own name, if there is one, shown in the plan as implicit. | `receipt:<name>`    |
| S02 | Agent `spec.brief: <shape>`, or `{ shape, format: header, header: { aliases } }` for the flat-line bridge                                                                                               | `brief:<agent>`     |
| S03 | `connections.<c>.operations.<tool>.input: <shape>`                                                                                                                                                      | `input:<c>.<tool>`  |
| S04 | `connections.<c>.operations.<tool>.output: <shape>`                                                                                                                                                     | `output:<c>.<tool>` |
| S05 | `evidence.<name>: { shape, producers, subject }`                                                                                                                                                        | `evidence:<name>`   |
| S06 | `memory.<name>: { shape, connection, operations, writers, deleters, max_records }`                                                                                                                      | `memory:<name>`     |
| S07 | `files.<name>: { root, pattern, frontmatter, sections, max_bytes, writers }`                                                                                                                            | `file:<name>`       |
| S09 | `inventory: { shape, values }`                                                                                                                                                                          | `inventory`         |

### S01 receipts

`format: fenced` (the default) reads the ` ```nodrail-receipt ` block that ends the message, as receipts are read today: the last block only, at most 8 KiB, YAML core schema, unique keys. `agent` is the envelope's reserved identity: it must match the observed dispatch and can't be a property of a receipt shape.

`format: header` is the explicit bridge for flat legacy receipts: `header.title` (default `RECEIPT {agent}`), `header.aliases` mapping a line key to a top-level property (`result: verdict`, `categories: findings`), and `header.mode_prefix` allowing `<mode>:` before the verdict word. A header shape is flat: scalars, enums, and findings as a list of categories or an object of integer counts. The mapped object then passes the same strict validator. There is no fallback from one format to the other.

```yaml contracts
nodrail.yaml:
  shapes:
    developer-result:
      properties:
        result: { values: [done, partial, blocked, code-defect], role: verdict }
        categories:
          {
            role: findings,
            type: list,
            max: 10,
            optional: true,
            of: { values: [tests, types, lint, docs] },
          }
        branch: { type: string, max: 200 }
    qa-result:
      properties:
        verdict: { values: [pass, fail], role: verdict }
        checks: { type: integer, min: 0, report: true }
  receipts:
    developer:
      shape: developer-result
      format: header
      header:
        {
          title: "RECEIPT {agent}",
          aliases: { result: result, categories: categories },
          mode_prefix: true,
        }
    qa: { shape: qa-result }
resources:
  - {
      apiVersion: nodrail.com/v1alpha1,
      kind: Agent,
      metadata: { name: developer },
      spec: { receipt: developer },
    }
  - {
      apiVersion: nodrail.com/v1alpha1,
      kind: Agent,
      metadata: { name: qa },
      spec: {},
    }
```

#### How a receipt is read (enforced, engine level 4)

One function, `readContractReceipt(message, contract, dispatchedAgent)` from `@nodrail/policy-engine/contracts`, reads a receipt for the local hook and for the control plane. It returns one typed value and a state:

- **valid**: the value, its verdict, the findings count derived by the runtime, and agent-reported usage.
- **invalid**: no verdict. Issues name a path and a code, never a value. Besides the value codes below, capture adds `parse` (not YAML, a key twice), `identity` (the receipt names another agent than the one dispatched) and `size` (the block that ends the message is over 8 KiB).
- **missing**: no block ends the message (`not-final`): there is none, it is quoted mid-message, or more text follows it.

Fenced: the block's `agent:` is optional; when present it must name the dispatched agent. Header: the header line may be bold (`**RECEIPT qa**`), the block may sit in a fence or start just outside one, lines run to the end of the message, a bullet before a line is allowed, a repeated closing header is ignored, and lines the contract doesn't map are dropped (this reader only). The verdict is the first word of its line, after `<mode>:` when `mode_prefix` allows it, compared in lowercase with trailing punctuation stripped: `result: plan: PLANNED · release: READY` says `planned`. A number or boolean line counts only when written as one; a findings line is read in parts split at `·`, `,`, `;`, `|` and `/`, each a category with or without its count before or after it (`0 blocker / 1 major / 0 minor`, `correctness 2 · scope-drift 1`, `tests, docs`), `none` for no findings. Into a list it gives the categories, leaving out any counted 0; into an object of counts it gives each declared category its count (`none` is all 0), and a category left out or written without a count is invalid, so `where: { findings.blocker: 0 }` works on a header receipt. A part that is neither one category with one count nor categories alone is never guessed at. A key a line gives twice is `duplicate`.

The runtime captures the final message where the host delivers it: Claude Code's `SubagentStop.last_assistant_message`, or, when a subagent ends through the `SubagentHandback` tool (permission mode `auto`), `PreToolUse(SubagentHandback).tool_input.message`. There an invalid or missing receipt is denied with its reason before delivery, and the subagent sends again; a valid one finishes the step once the rules let the hand-back through, which they do when no rule covers it (see [Commands and tools](commands-and-tools.md)). Copilot's `subagentStop.response`, or its Claude-format `last_assistant_message`. A step finishes once: later deliveries for the same agent id are ignored. The framed copy a parent receives is never read.

#### Contracts in a rule file

The hook reads only rule files, so the contracts it checks travel in one `contracts` entry, in a file that asks for engine level 4. It holds `shapes` and `receipts` as `nodrail.yaml` writes them; `agents` picking each agent's `receipt` and `brief` (a receipt named like an agent is that agent's); and `connections.<c>.operations.<op>.input`. Other contract keys, an operation's `output` included, are refused by this engine.

```yaml
- required_engine_version: 4
- contracts:
    shapes:
      reviewer-result:
        properties:
          verdict: { values: [ship, ship-with-debt, fix-first], role: verdict }
          findings:
            role: findings
            properties: { blocker: { type: integer, min: 0 } }
    receipts:
      reviewer: { shape: reviewer-result }
- rule: Open pull requests
  tool: claude-code
  operation: agent
  resource: { kind: agent, match: exact, value: github }
  effect: allow
- gate: Reviewed before the pull request
  tool: claude-code
  operation: agent
  resource: { kind: agent, match: exact, value: github }
  requires:
    - agent: reviewer
      verdict: [ship, ship-with-debt]
      where: { findings.blocker: 0 }
      subject: revision
  otherwise: deny
```

The compiled document is `version: 3`: each agent's resolved receipt contract, pinned by its digest, and each requirement's compiled `where`, `authority: agent-reported` and `subject`. A requirement is met when the agent's **latest** finished step (per revision, with `subject: revision`) started after the last change (as before, with `since`), ended with a **valid** receipt read with the same contract digest, says an accepted verdict and meets every `where`. An earlier receipt never counts once a later one exists: a later invalid or failing receipt closes the gate. `subject: revision` also needs the revision the runtime read when the step finished (the commit, the tracked diff and the untracked files) to equal the revision now; an unknown revision is unmet. Nothing a receipt says (`anchor: fresh`) stands in for either. A gate that is met never allows what no rule allows. Agents without a declared receipt are read as before.

### S02–S04 briefs and tools

A brief, a tool's input and a tool's result accept no roles. A brief is validated before a covered dispatch; a prose prompt is not a brief. Input is validated before the provider is called, against the same action descriptor that is evaluated. A result is validated after the provider returns: an invalid result is unusable downstream, and the execution it reports is recorded apart from its conformance.

#### Briefs and tool inputs (enforced, engine level 4)

Both are checked by the hook on the exact call the host is about to run, before any rule. A refusal is a deny with the reason (paths, codes and declared bounds, never a value), so the agent never starts and the provider is never called. A valid value is what `where` reads.

**Brief.** The contract is the one of the agent the call starts: Claude Code's `subagent_type` (`Agent`, `Task`), Copilot's `agent_type` (`task`, and `Agent` in Claude Code's hook format). Nothing in the prompt chooses it. `readBrief(prompt, contract, agent)` from `@nodrail/policy-engine/contracts` reads it:

- fenced (the default): the ` ```nodrail-brief ` block that ends the prompt, read as receipts are: the last block only, at most 16 KiB with its fences, YAML core schema, unique keys. A block quoted mid-prompt, or followed by more text, is no brief (`missing`, `not-final`). An `agent:` key is optional and must name the agent being started (`identity`); it is no property of the brief.
- `format: header`: the explicit bridge for flat lines a team already writes (`issue: ENG-1`, `Budget: 80`), wherever they are in the prompt. A line's key, in lowercase, fills its alias's property, else the property of its name, unless an alias targets that property: once a property has an alias, only the alias fills it and a line with its own name is dropped. Other lines are prose and are dropped; a property two lines fill is `duplicate`. Values are typed as receipts' header lines are. A header brief is flat: no objects or lists.

The states stay distinct: **valid**; **invalid**; **missing** (no block, or none of the brief's lines); **unobservable**, when the host doesn't show the hook the brief: Codex hands its subagents an encrypted message, so starting an agent with a declared brief there is denied.

**Tool input.** A call to a connection operation with a declared `input` is checked with `checkInput(contract, input)` (`/contract-values`): strict, so an argument the shape doesn't declare is `unknown`; over 16 KiB is `size`. The call is matched by the tool and operation it is judged as (`mcp__stripe__refund` is `stripe refund`). Arguments under a `secret` or `pii` classification are shown to reviewers as `[classified]` (`withoutClassified`); the input's fingerprint still binds the exact call.

`where` on a rule or a gate reads `input.<path>` (the operation named by `tool` and `operation`) or `brief.<path>` (a rule on starting one agent: `resource: { kind: agent, match: exact, value: <agent> }`), with the same matcher as gate requirements. Every condition must hold, and a missing value satisfies none. A document checked without validated values (another evaluator, a simulation) never lets an allow with `where` match, and still lets a deny match. A result (`result.`) is read where the call is mediated, never by this hook.

```yaml
- required_engine_version: 4
- contracts:
    shapes:
      refund-args:
        properties:
          amount: { type: integer, min: 1, unit: usd_cents }
          environment: { values: [staging, production] }
          card_token:
            { type: string, max: 64, classification: secret, optional: true }
      work-brief:
        properties:
          issue: { type: string, max: 40 }
          budget: { type: integer, min: 1, max: 500 }
    agents:
      developer:
        brief:
          shape: work-brief
          format: header
          header: { aliases: { ticket: issue } }
    connections:
      stripe:
        operations:
          refund: { input: refund-args }
- rule: Small refunds in staging
  tool: stripe
  operation: refund
  resource: { kind: mcp_tool, match: any }
  where: { input.amount: { max: 5000 }, input.environment: staging }
  effect: allow
- rule: Never refund large amounts
  tool: stripe
  operation: refund
  resource: { kind: mcp_tool, match: any }
  where: { input.amount: { min: 5001 } }
  effect: deny
- rule: Never refund in production
  tool: stripe
  operation: refund
  resource: { kind: mcp_tool, match: any }
  where: { input.environment: production }
  effect: deny
- rule: Start the developer on a small budget
  tool: claude-code
  operation: agent
  resource: { kind: agent, match: exact, value: developer }
  where: { brief.budget: { max: 100 } }
  effect: allow
```

Rules and gates in a version 3 document carry their compiled `where` (paths start with `input` or `brief`); the document carries `briefs` by agent and `inputs` by `<tool>.<operation>`, each pinned by its contract digest, only when declared.

### S05 evidence

```yaml contracts
nodrail.yaml:
  shapes:
    ci-result:
      properties:
        status: { values: [passed, failed], report: true }
        tests: { type: integer, min: 0, report: true }
        log_url: { type: string, max: 500 }
  evidence:
    ci-tests:
      shape: ci-result
      producers:
        - { class: externally-verified, verifier: github-actions }
        - { class: runtime-observed }
      subject: revision
```

`producers` lists who may produce it: `runtime-observed` (the local runtime saw it happen) or `externally-verified`, which names a verifier configured on the server. A provider name or a URL in the payload proves nothing. `subject: revision` means each event is bound by the runtime to the revision it is about.

#### Evidence requirements (enforced, engine level 5)

> **Control plane.** The local hook enforces evidence requirements at engine level 5. The control plane's side, taking `externally-verified` evidence from CI and answering the status a hook asks, arrives with the matching server release.

A gate requirement `{ evidence, authority, subject: revision, where }` needs `required_engine_version: 5` in its file, and so does `evidence` in a rule file's `contracts` entry. It compiles to a version 4 document: the gate's `evidence` list, each pinned to the evidence contract's digest, and the document's `evidence` contracts with their producers. In v1 every evidence requirement says `subject: revision`; `subject: none` evidence is for views and insights only. A `where` on a `classification: secret` path of evidence is refused: the control plane never keeps a secret path, so the condition could never be evaluated there.

```yaml
- required_engine_version: 5
- contracts:
    shapes:
      ci-result:
        properties:
          status: { values: [passed, failed], report: true }
    evidence:
      ci-tests:
        shape: ci-result
        producers:
          - { class: runtime-observed }
          - { class: externally-verified, verifier: github-actions }
        subject: revision
- rule: Push
  command: { prefix: git push }
  effect: allow
- gate: Tested before a push
  command: { prefix: git push }
  requires:
    - {
        evidence: ci-tests,
        authority: externally-verified,
        subject: revision,
        where: { status: passed },
      }
  otherwise: deny
```

A requirement is met by the latest event of that evidence whose subject is the current revision (the commit, the tracked diff and the untracked files, read from the top of the work tree). The checks run in this order, and the first that fails is the explanation:

1. The current revision can't be read.
2. There is no event for this revision ("the latest is for abc123…; the work changed since", or "your tree has uncommitted or untracked changes" when the latest is for the clean commit).
3. The producer class is below the authority asked.
4. The verifier was revoked; revocation counts for all of its evidence, past and future.
5. The value was validated against another revision of the contract: run the producer again under the published contract.
6. The value is invalid or missing.
7. `where` fails. Only the declared condition is said, never an observed value.

Where each event comes from:

- `runtime-observed` events come from the ledger folder's `evidence/<name>.jsonl`, written by `nodrail evidence run`. Readers dedupe on the event id. Events match by subject only, so a copied old line never satisfies new work.
- `externally-verified` evidence is the control plane's to confirm. With `nodrail-policy hook --evidence <file>` (`{ url, workspace_revision }`, and the person's token in `NODRAIL_TOKEN` with the `read` scope), the hook asks `GET /api/v1/evidence/status` only about the requirements of gates that cover the call and aren't met locally. It asks by gate id, requirement index and subject, never with a condition of its own, and waits at most 3 seconds.
  - A positive answer is cached for 5 minutes per requirement and subject. A negative one is never cached.
  - Offline, an unpublished revision, a token without `read`, a timeout or an error leave the requirement unmet, with the reason.
  - Copilot's native hook reads local evidence only.

`@nodrail/policy-engine/revision` exports `cleanRevision(commit)`, the revision a clean checkout of that commit reads: the control plane ties a CI run's `sha` to the local subject with it. A `pull_request` run's merge commit never matches a local head.

### S06 memory through a connection

The record shape needs exactly one `kind`. `writers` maps each kind value to the agents that may create or update it; `deleters` may delete. An operation's `input`, if declared, must be the record shape. Storing a lesson never promotes it to a rule: that is a separate policy change a person makes. A memory contract adds no storage and never deletes data.

### S07 files

`root` is a project folder; `pattern` a `.md` path below it where `*` matches within one folder level (no `**`). `frontmatter` is a shape for the leading `---` YAML block (core schema, so dates stay quoted strings); `sections` are required level-2 (`## `) headings, matched by exact trimmed text, a name given twice (in any case) is refused; `{ name, optional: true }` makes one optional. Files are UTF-8, at most `max_bytes` (default 64 KiB, at most 256 KiB). Duplicate sections, traversal and unsafe links are rejected when content is validated. Existing protected `data:` paths stay protected.

### S09 inventory

```yaml contracts
nodrail.yaml:
  shapes:
    project-labels:
      properties:
        team: { values: [payments, growth], report: true }
        cost_centre: { values: [cc-100, cc-120], report: true }
  inventory:
    shape: project-labels
    values: { team: payments, cost_centre: cc-120 }
```


Inventory labels are single values, validated against the shape at compile. Labels describe; they never grant a role, move billing or change a project's tenant.

## Conditions: where

`where` maps a dotted path to one condition; all must hold:

- an exact value: a string, number or boolean of the property's type (an enum value it declares; a quoted date);
- `{ min, max }`: numbers for `integer`/`number`, quoted dates for `date`;
- `{ in: [...] }`: values for an enum, string or integer.

No expressions, JavaScript, conversions or JSONPath. A path must exist in the resolved shape with a compatible type, and can't go into a list: lists are never searched, flattened or summed. A missing value satisfies no condition, optional or not.

## Consumers (C01–C10)

Consumer fields in rule files need `required_engine_version: 4` in the file; evidence requirements and numeric budgets need 5.

| ID  | Declared at                                                                                                                                                                                                          | Checks                                                                                                                                                                                                                                                         |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C01 | Gate `requires:` entries gain `where`, `authority`, `subject: revision`, and an evidence form `{ evidence, authority, where, subject }`.                                                                             | Verdicts must be ones the receipt declares; a receipt is `agent-reported`, so asking it for more is an error; evidence must have a producer of the required authority; `subject: revision` needs evidence declared with it.                                    |
| C02 | Rule and gate `where:` with paths starting `input.`, `result.` (the operation named by `tool` and `operation`) or `brief.` (a rule on starting an agent: `resource: { kind: agent, match: exact, value: <agent> }`). | `result` conditions decide what may use a result next, never permission retroactively.                                                                                                                                                                         |
| C03 | Budget `sum: { tool, operation, path }` and `unit:`                                                                                                                                                                  | The path is an `integer` (whole minor units) whose `unit` equals the budget's. An `input.` path is known before the call (admission, reservable); a `result.` path is measured after it and is never a guaranteed cap. Agent-reported usage never feeds these. |
| C05 | `views.<name>: { source, columns, filters }`                                                                                                                                                                         | Columns are reported scalars; filters reported enums, booleans, dates or numbers.                                                                                                                                                                              |
| C06 | Test `cases: [{ name, target, value, expect, issues, projection }]`                                                                                                                                                  | `target` is a binding name or `shape:<name>`. Side-effect free: no tool runs.                                                                                                                                                                                  |
| C07 | The lock's `contracts:` section                                                                                                                                                                                      | See [Digests and the lock](#digests-and-the-lock).                                                                                                                                                                                                             |
| C08 | A module's `shapes:` and `receipts:`, imported at an exact `@scope/name@version`                                                                                                                                     | The same name with a different definition is a collision, whatever the order; an identical one is shared.                                                                                                                                                      |
| C09 | `insights.<name>: { source, measure, path, group }`                                                                                                                                                                  | `measure` is `count`, `validity`, `verdicts` or `rework` (receipts) or `sum` (a reported number with a unit). Groups are reported enums or booleans. Denominators include missing, invalid and unsupported records.                                            |
| C10 | `notifications.<name>: { source, where, fields, to }`                                                                                                                                                                | Fields and conditions read reported values only. Exports and the API apply the same projection.                                                                                                                                                                |

`source` is `{ receipt: <name> }`, `{ evidence: <name> }` or `{ memory: <name> }`. C05, C09 and C10 run off the machine, so every path they name must be reported. A notification goes `to` a server role, `admin` or `policy_manager`.

### Numeric budgets (enforced, engine level 5)

> **Control plane.** The local hook enforces numeric budgets at engine level 5. The control plane doesn't enforce them yet; that support arrives with the matching server release.

A numeric budget needs `required_engine_version: 5` in its file and compiles into a version 4 document's `limits`. A file's legacy `tool_calls`, `tokens` and `usd` budgets stay in `budgets`, read as before. A budget counts exactly one thing:

| Field                                      | Counts                                                     | Unit                           | Source    | Label                                 |
| ------------------------------------------ | ---------------------------------------------------------- | ------------------------------ | --------- | ------------------------------------- |
| `count: { tool, operation }`               | calls of the operation the hook let go ahead               | `calls`                        | admission | Enforced allowance                    |
| `sum: { tool, operation, path: input.… }`  | an integer input known before the call                     | the property's, e.g. usd_cents | admission | Enforced allowance                    |
| `sum: { tool, operation, path: result.… }` | an integer result, measured after the call                 | the property's                 | measured  | Measured usage · stops further work   |
| `tokens: N` with `source: measured`        | subagent tokens the host measured (Claude Code foreground) | `tokens`                       | measured  | Measured usage · stops further work   |
| legacy `tokens:` / `usd:`                  | what agents reported in receipts                           | tokens / USD                   | agent     | Agent-reported usage · advisory limit |

Labels follow from the source and can't be configured. Sources never mix in one budget.

- **`limit`.** A whole number above 0, in minor units. A measured tokens budget's limit is its `tokens` value.
- **`per`.** `step`, `run` or `day`. A day needs `timezone`, an IANA name: the day is local, so it is 23 or 25 hours when the clocks change.
- **`across`.** `run` (the default for a step or run) or `environment`, and `per: day` must say which. `across: environment` needs the shared online authority: the local hook holds every call such a budget covers ("shared budgets are enforced only on a control-plane-managed connection"), and plan fails its activation.

```yaml
- required_engine_version: 5
- contracts:
    shapes:
      refund-args:
        properties:
          amount: { type: integer, min: 1, unit: usd_cents }
    connections:
      stripe:
        operations:
          refund: { input: refund-args }
- rule: Refunds
  tool: stripe
  operation: refund
  resource: { kind: mcp_tool, match: any }
  effect: allow
- rule: Publish
  tool: outbox
  operation: publish
  resource: { kind: mcp_tool, match: any }
  effect: allow
- budget: Publications per run
  count: { tool: outbox, operation: publish }
  limit: 3
  per: run
  otherwise: deny
- budget: Refunds per day
  sum: { tool: stripe, operation: refund, path: input.amount }
  unit: usd_cents
  limit: 20000
  per: day
  timezone: Europe/Madrid
  across: run
  otherwise: deny
```

**Reserve and settle (local).** The hook decides and reserves under the run's lock, so two calls can't both take the last slot. A call that goes ahead sets aside its amount in each admission budget that covers it, as `budget.reserved`, keyed `host:tool_use_id`.

- **Repeated delivery.** A second PreToolUse with the same key gets the decision the first got and reserves nothing.
- **PostToolUse.** The reservation is consumed.
- **Released.** Only when the mediated connector's record for the call says `failed` or `not-called` (input refused included). The record is joined by connection, operation and input digest to the oldest open reservation.
- **Unknown.** A PostToolUseFailure without such a record, no Post at all (a declined prompt, a crash) or a mediated `unknown` leaves the reservation unknown, and it still counts until the person reconciles it.
- **What counts.** Reserved, consumed and unknown amounts all count. An amount that can't be known before the call, or a total that would pass safe integers, holds the call.
- **Measured budgets.** They count what was measured. A step with no reading (a background subagent, a failed call, a result without the path) is unknown, and unknown holds: "≥ N of L tokens, k steps unknown".
- **Agent claims.** Nothing an agent reports (`usage: 0` in a receipt) touches these totals.

Settlements need the hook on PostToolUse and PostToolUseFailure too. `@nodrail/policy-engine/ledger` exports `record`, `withRunLock`, `settleMediatedCall` and `reconcile` for connectors and the CLI.

Hook timeouts still fail open on the host side. `hook-guard` exits 2 at 15 s, so a hook that never answers blocks the call.

```yaml contracts
nodrail.yaml:
  shapes:
    reviewer-result:
      properties:
        verdict: { values: [ship, ship-with-debt, fix-first], role: verdict }
        findings:
          {
            role: findings,
            report: true,
            properties: { blocker: { type: integer, min: 0 } },
          }
    ci-result:
      properties:
        status: { values: [passed, failed], report: true }
        duration_ms: { type: integer, min: 0, unit: ms, report: true }
    refund-args:
      properties:
        amount: { type: integer, min: 1, unit: usd_cents, report: true }
        currency: { values: [usd, eur], report: true }
  receipts:
    reviewer: { shape: reviewer-result }
  evidence:
    ci-tests:
      shape: ci-result
      producers: [{ class: externally-verified, verifier: github-actions }]
      subject: revision
  connections:
    stripe:
      command: npx
      operations:
        refund: { input: refund-args }
  views:
    reviews:
      {
        source: { receipt: reviewer },
        columns: [verdict, findings.blocker],
        filters: [verdict],
      }
  insights:
    verdicts: { source: { receipt: reviewer }, measure: verdicts }
    ci-time:
      {
        source: { evidence: ci-tests },
        measure: sum,
        path: duration_ms,
        group: [status],
      }
  notifications:
    fix-first:
      {
        source: { receipt: reviewer },
        where: { verdict: fix-first },
        fields: [verdict, findings.blocker],
        to: { role: admin },
      }
resources:
  - {
      apiVersion: nodrail.com/v1alpha1,
      kind: Agent,
      metadata: { name: reviewer },
      spec: { receipt: reviewer },
    }
policy:
  - required_engine_version: 5
  - gate: Reviewed and tested before merge
    tool: github
    operation: pr.merge
    resource: { kind: repository, match: any }
    requires:
      - {
          agent: reviewer,
          verdict: [ship, ship-with-debt],
          where: { findings.blocker: 0 },
        }
      - {
          evidence: ci-tests,
          authority: externally-verified,
          subject: revision,
          where: { status: passed },
        }
    otherwise: deny
  - rule: Small refunds
    tool: stripe
    operation: refund
    resource: { kind: charge, match: any }
    where: { input.amount: { max: 5000 }, input.currency: { in: [usd, eur] } }
    effect: allow
  - budget: Refunds per run
    sum: { tool: stripe, operation: refund, path: input.amount }
    unit: usd_cents
    limit: 20000
    per: run
    otherwise: deny
```

## Older engines refuse, never ignore

Parsing a declaration is not enforcing it, so every place a contract can be written is one an older engine refuses:

1. `nodrail.yaml` and Agent resources are strict: today's CLI rejects `shapes:`, `receipts:`, `spec.receipt` and every other key on this page.
2. Rule files: contract fields need `required_engine_version: 4`. Engines up to level 3 refuse such a file and say why; the compilers refuse contract fields in a file that doesn't ask for level 4. Level 4 enforces receipts and gate requirements on them, briefs, operation inputs and `where` on rules and gates. Level 5 adds evidence requirements and numeric budgets: engines up to level 4 refuse a file that asks for 5, and the compilers refuse those fields in a file that doesn't. An operation's `output` or another surface's key is still refused, until it is enforced. An engine from before briefs and inputs refuses their keys (`agents.<a>.brief`, `connections`, a rule's `where`) and a document carrying them, rather than ignoring them.
3. A compiled policy document that carries contracts is `version: 3`; one with evidence requirements or numeric budgets is `version: 4`. Readers before each version reject it, as engines before level 3 reject gates.
4. Inside the grammar every object is strict: a later dialect's key (`pattern:`, a new role, a new condition form) is an error in dialect 1.
5. A compiled closure lists the surfaces (`S01`…) and consumers it uses. A runtime that can't capture or enforce one must fail activation for it, and keep dependent gates closed, rather than run as if it were enforced.

## Digests and the lock

A digest is `sha256:` and the hex SHA-256 of `nodrail:<domain>:v1`, a newline, and the RFC 8785 (JCS) canonical JSON of what it pins. Domains: `shape`, `projection`, `binding`, `workspace`, `value`. Display prefixes are never identity.

- **Shape (contract) digest**: the resolved shape, `extends` merged, with every field explicit: `type` (`enum`, `object` and `list` included), `optional`, `for` (null when absent), `report` (null when unstated), `classification`, `role`, and the type's bounds with defaults filled in (`min: 0, max: 1000` for strings, `min: 0, max: 50` for lists, `null` for unset number and date bounds, `unit`). The shape's name and parent are not part of it: the same content has the same digest.
- **Projection digest**: the projected shape and its withheld paths.
- **Binding digest**: surface, binding name, shape and projection digests, and the attachment's options (format, producers, writers…).
- **Workspace digest**: dialect, every shape's contract and projection digests, binding digests, each Agent's resolved receipt and brief, and every compiled consumer reference.

Key order and property order never change a digest; any change to a type, bound, value, role, `for` text, reporting or classification does. The lock records:

```yaml lock
contracts:
  dialect: 1
  digest: sha256:… # workspace
  shapes:
    qa-result: { contract: sha256:…, projection: sha256:… }
```

A lock that differs from the recompiled contracts is refused until the change is reviewed and locked again. Records carry the digest they were validated with; history is never revalidated against the latest contract.

## Authority, provenance and privacy

### Producer classes

| Class                  | Who                                                                                     | May satisfy                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `agent-reported`       | An agent's receipt or claim.                                                            | Requirements on `agent-reported`.                                             |
| `runtime-observed`     | The local runtime (hook, adapter) saw it.                                               | `runtime-observed` and below.                                                 |
| `externally-verified`  | A verifier configured on the server, with authenticated evidence for the exact subject. | Every gate authority.                                                         |
| `person-authenticated` | A person signed in to the control plane: labels.                                        | Only what asks for a person; never stands in for the others, nor they for it. |

Structure proves conformance, not truth: `anchor: fresh`, `tests_passed: true` or `usage.usd: 0` in a valid receipt prove nothing. Provenance is relative to the deployment's trust boundary; local records can be altered by whoever owns the machine. Passing a gate never grants a permission the policy lacks.

### Runtime-owned metadata

The envelope of every validated record is set by the runtime or the server, never by a payload field: `surface`, `producer` (class and id), `contract` (name, digest, dialect), `projection` (digest), `validation` (state, where it ran, safe issues), `project`, `machine`, `host`, `run`, `step`, `agent`, `dispatch`, `event` (stable across retries), `occurred_at`, `recorded_at` and `subject` (kind and digest of the revision, action or file it is about). A receipt's `agent` only has to match the observed dispatch. Freshness comes from `subject` and the run's observed order, never from a declared value.

### Full contract and reporting projection

The full value is validated locally against the full pinned contract. A separate, versioned **projection** decides what leaves the machine:

- Every custom property is opt-in (`report: true`), whatever its type: strings, enums, numbers and booleans alike.
- `classification: secret` or `pii` always wins, its own or an ancestor's. `report: true` on or under a classified property is an error, not overridden silently.
- `report: true` on an object or list opts in what it holds, except classified children and children that say `report: false`. Without it, nested properties are withheld.
- Built-in safe fields keep their behavior: the `verdict` and `usage` roles are reported unless they say `report: false`; the findings count is derived by the runtime and reported with the envelope.
- The projected schema is itself a shape: the reported properties with their types, bounds and `for` text, and the withheld paths by name. Descriptions of withheld properties never leave the machine.

A required property left out by the projection does not make the projected record malformed: the projection is validated against the projected schema, where it isn't required. The control plane records the producer's full-validation state with its authority (`validation.at: local`) and does not attest to what it never saw. A reported record can't satisfy an authoritative control-plane gate. When a control-plane authorization needs a private value, it is submitted through that authorized channel under its own disclosure rules, or the requirement stays unmet.

The same projection applies to run events, schema descriptions, examples, errors, previews, notifications, exports, charts and the API.

### Tokens and roles

| Operation                                                 | Token scope                                                | Server roles                                            |
| --------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------- |
| Read projected schemas, reported records, views, insights | `workspace:read`                                           | Per existing view rules; viewers see their own sources. |
| Publish contracts (with the workspace revision)           | `policies:write`                                           | admin, policy_manager                                   |
| Report projected records                                  | `inventory:write` (reporting only)                         | Any member, for their own machines. Never authorizes.   |
| Submit authoritative evidence                             | a new `evidence:submit`, held by configured verifiers only | —                                                       |
| Edit inventory labels                                     | `policies:write` through the published workspace           | admin, policy_manager                                   |

Existing reporting-only tokens gain no policy or evidence privileges. Tenancy comes from the authenticated context, never from a field.

### Retention

Contract and projection revisions are immutable and kept as long as any retained record references them; a record whose contract is gone is shown as "contract unavailable", never revalidated against a later one. Records follow the workspace's existing retention, deletion and export. Persistent memory and files are never removed by `destroy` and stay out of configuration locks; their schema and path bindings are locked.

## Validation and issues

States stay distinct: **valid**, **invalid** (no usable verdict, never recovered from prose), **missing**, and **unsupported** capture (a brief the host doesn't show the hook is **unobservable**; a mediated result that can't be read as a value is **unsupported**). An issue names a path and a reason (`findings.blocker: type`), never the rejected value.

Value issue codes: `required`, `unknown`, `type`, `enum`, `too-short`, `too-long`, `too-few`, `too-many`, `below`, `above`, `duplicate`, and `size` (path `(value)`: an input, brief or result over its byte limit).

Compile issue codes: `grammar`, `unknown-shape`, `extends-chain`, `depth`, `property-count`, `role-placement`, `role-count`, `role-required`, `role-unsupported`, `report-classified`, `reserved-name`, `header-nesting`, `unknown-reference`, `binding-conflict`, `kind-value`, `inventory-shape`, `value`, `path`, `path-type`, `path-through-list`, `not-reported`, `verdict-value`, `authority`, `subject`, `unit`, `engine-level`, `collision`, `lock-mismatch`, `case-failed`. Every issue is an error; there are no warnings.

## Limits

| What                                       | Bytes                                        |
| ------------------------------------------ | -------------------------------------------- |
| Receipt block, fences included             | 8 KiB                                        |
| Brief, tool input, evidence, memory record | 16 KiB                                       |
| Tool result                                | 64 KiB                                       |
| File                                       | 64 KiB by default, `max_bytes` up to 256 KiB |
| Inventory labels                           | 4 KiB                                        |

These apply at the transport or attachment boundary, before validation.
