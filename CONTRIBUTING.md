# Contributing

Thanks for helping. Bug reports, rule examples, framework adapters and fixes are
all welcome.

## Setup

Needs Node 22 or later and pnpm (`corepack enable` gives you the right version).

```sh
pnpm install
pnpm verify   # types, lint, tests, and a clean install of each built package
```

| Folder                    | What it is                                                     |
| ------------------------- | -------------------------------------------------------------- |
| `packages/policy-engine`  | The evaluator, YAML rules and the `nodrail-policy` command line |
| `packages/client`         | The SDK, `guard()`, the LangChain middleware and the agent hook |

`pnpm --filter @nodrail/policy-engine rules validate examples/rules` runs the
command line from source.

## Pull requests

Titles follow `type(scope): summary`, for example
`fix(engine): match secret names case-insensitively`, and a check enforces it.
See [names and descriptions](https://github.com/Nodrail/.github/blob/main/CONTRIBUTING.md#names-and-descriptions).

- Open an issue first for anything large, or that changes how rules are judged.
- Add a test. If you're fixing a way around a rule, add the exact input to the
  tests.
- Run `pnpm changeset` if users would notice the change, and commit the file it
  creates. It becomes the changelog entry and decides the next version.
- Keep the evaluator free of Node APIs, and keep dependencies few. A test enforces
  the boundaries.
- Anything that can't be decided must block. A new code path that could let a
  call through on an error needs a test showing it doesn't.

Changes to precedence or to the policy document format need particular care:
other evaluators rely on
`packages/policy-engine/tests/fixtures/conformance-v1.json`.

A new framework in `guard()` needs a test that runs the framework's real agent
loop with a fake model, like the ones in `packages/client/tests`.

## Releases

Merging to `main` updates a "Version packages" pull request. Merging that one
publishes to npm with provenance, tags each package and writes its GitHub
release.

## Licence of contributions

Contributions are made under the [Apache-2.0](LICENSE) licence, as its section 5
describes. There is no separate agreement to sign.

## Conduct and security

Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md). Please
don't open a public issue for a vulnerability: see [SECURITY.md](SECURITY.md).
