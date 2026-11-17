---
name: author-apf-playbooks
description: Compose Nodrail APF playbooks from existing roles and policy modules, inspect effective authority, and test each step across harnesses.
---

Start with the operation the team is delegating and the authority it needs. Opening a draft PR and merging one are separate operations. Identify who controls the adapter, the repository and branch scope, and which execution paths it observes.

Keep ordinary APF entries in the policy modules. List modules and local files under `imports` in the project's nodrail.yaml, in the order they apply. Resolve imports in declared order before local policy files, compile the entire result, and inspect the effective permissions and explicit overrides before activation. Use native APF ordered files or a policy folder when a playbook resolver is unavailable.

For a review prerequisite, identify which revision QA and the reviewer examined. The adapter supplies trusted subject and run metadata. A reported pass alone cannot establish that the candidate still matches. Test the same policy digest with positive and negative scenarios on each advertised integration, including an outdated QA result, a scoped-out target and an operation the role never received.

For this example read the module's module.yaml, then run `nodrail policy lock` and `nodrail policy export --frozen` in a project that uses it. Publishing or merging requires the caller's existing authorization.
