---
name: review-apf-permissions
description: Review the effective permissions of a Nodrail playbook before activation, including permission changes introduced by transitive modules.
---

Inspect the resolved policy and its module order. For each role, list allowed operations with their actual resource and condition scopes, actions held for approval or evidence, and explicit denies. An unmet prerequisite can only tighten a base decision. An uncovered action requires fail-closed handling in the consuming adapter.

When reviewing a change, compare the previous and proposed effective policies and run paired scenarios on both. Call out newly reachable actions, relaxed prerequisites and changes in resource scope. For delegation or publication, test who supplies the role and whether evidence is bound to the current artifact. Report which paths the adapter actually mediates.

For a project that uses @nodrail/open-reviewed-pr, run `nodrail policy lock` to see the permission changes since the last review, and read `nodrail policy export --frozen` for the policy agents will get. Distinguish a denied permission request from an actual provider-side access control, and case evaluation from a live side effect.
