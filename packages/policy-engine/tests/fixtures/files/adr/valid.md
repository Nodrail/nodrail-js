---
status: accepted
date: "2026-11-21"
deciders: [alex]
---

# ADR 0012: File contracts validate the complete result

## Context

Agents write ADRs, notes and handoffs straight to the repository. See the
[contracts reference](../../packages/policy-engine/docs/contracts.md) and
[the spec](https://nodrail.com/docs/contracts#s07).

## Decision

Validate the complete proposed file for each supported write.

```markdown
## Decision

A heading inside a code block is not a section.
```

### Alternatives

Post-write detection only: rejected, it flags drift but can't prevent it.

## Consequences

Writes whose result can't be reconstructed are refused for governed files.
