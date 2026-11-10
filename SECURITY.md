# Security policy

Nodrail decides whether an AI agent's action may run. A bug that lets an action
through when it should be blocked is a security problem, and we treat it as one.

## Reporting a vulnerability

Report it privately, never in a public issue:

- [Open a private advisory](https://github.com/Nodrail/nodrail-js/security/advisories/new) on GitHub (preferred), or
- write to hello@nodrail.com.

Include the package and version, the rules and the call involved, and what you
expected. A failing test is the most useful thing you can send.

We aim to acknowledge reports within three working days, keep you informed while
we fix it, and credit you in the advisory unless you'd rather we didn't.

## What counts

- A governed tool or command runs without a fresh, exact allow.
- A rule matches something it shouldn't, or misses something it should, in a way
  the [rules documentation](packages/policy-engine/docs/rules.md) doesn't describe.
- The hook lets a call through when Nodrail can't be reached, refuses the
  credential, or times out.
- A secret or file content reaches Nodrail when the documentation says it doesn't.
- Anything in a published package that runs code its user didn't ask for.

The [security model](packages/policy-engine/docs/security-model.md) and the
client's **Limits** list what isn't guaranteed. Those aren't vulnerabilities, but
we'd still like to hear about ways to make them smaller.

## Supported versions

Fixes go to the latest release of each package. Before 1.0, that is the only
supported version.

## How releases are protected

- **Staged and approved.** GitHub Actions stages each version on npm with
  [provenance](https://docs.npmjs.com/generating-provenance-statements), using
  npm trusted publishing, so no npm token exists. Nothing is installable until
  a maintainer approves it with two-factor authentication.
- **Traceable.** From 0.1.1 on, every version's provenance links it to the
  commit and workflow run that built it; check it with `npm audit signatures`.
  0.1.0 was published from a maintainer's machine and has no provenance.
- **One maintainer, for now.** Changes reach `main` only through pull requests
  that passed CI, CodeQL, dependency review and a workflow audit, on Linux,
  macOS and Windows. With a single maintainer there is no second reviewer: pull
  requests don't wait for an approval, and organization admins can bypass the
  branch rules. See [GOVERNANCE.md](GOVERNANCE.md).
- Workflows pin each action to a full commit and start with read-only tokens.
